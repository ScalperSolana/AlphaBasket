use futures::executor::block_on;
use gtest::System;
use polymarket_mirror::WASM_BINARY;
use polymarket_mirror_client::{
    Basket, BasketAssetKind, BasketItem, BasketMarketConfig, BasketMarketInit, BasketStatus,
    ItemResolution, Outcome, PolymarketMirror, PolymarketMirrorCtors, PolymarketMirrorProgram,
    SettlementStatus, SignedVaraBetQuote, VaraBetQuotePayload, basket_market::BasketMarket,
};
use sails_rs::{
    client::{GtestEnv, Program as _},
    prelude::*,
};
use schnorrkel::{signing_context, ExpansionMode, MiniSecretKey};

const ADMIN: u64 = 1;
const SETTLER: u64 = 2;
const USER: u64 = 3;
const OTHER_USER: u64 = 4;
const TEST_BALANCE: u128 = 200_000_000_000_000;
const QUOTE_SEED: [u8; 32] = [7; 32];
const FUTURE_END: u64 = 1_900_000_000_000;

struct Harness {
    env: GtestEnv,
    program: sails_rs::client::Actor<PolymarketMirrorProgram, GtestEnv>,
    quote_signer: schnorrkel::Keypair,
}

impl Harness {
    fn new(liveness_ms: u64) -> Self {
        let system = System::new();
        system.mint_to(ADMIN, TEST_BALANCE);
        system.mint_to(SETTLER, TEST_BALANCE);
        system.mint_to(USER, TEST_BALANCE);
        system.mint_to(OTHER_USER, TEST_BALANCE);
        let code_id = system.submit_code(WASM_BINARY);
        let env = GtestEnv::new(system, ADMIN.into());
        let quote_signer = MiniSecretKey::from_bytes(&QUOTE_SEED)
            .expect("test quote seed")
            .expand_to_keypair(ExpansionMode::Ed25519);
        let quote_signer_actor = ActorId::from(quote_signer.public.to_bytes());

        let program = block_on(
            PolymarketMirrorProgram::deploy(code_id, b"toggle-tests".to_vec())
                .with_env(&env)
                .new(BasketMarketInit {
                    admin_role: ADMIN.into(),
                    settler_role: SETTLER.into(),
                    liveness_ms,
                    quote_signer: quote_signer_actor,
                    bet_cutoff_ms: 60_000,
                }),
        )
        .expect("program deploy");

        Self { env, program, quote_signer }
    }

    fn advance_blocks(&self, blocks: u32) {
        let next_block = self.env.system().block_height().saturating_add(blocks);
        self.env.system().run_to_block(next_block);
    }

    fn basket_count(&self) -> u64 {
        self.program
            .basket_market()
            .get_basket_count()
            .query()
            .expect("basket count query")
    }

    fn vara_enabled(&self) -> bool {
        self.program
            .basket_market()
            .is_vara_enabled()
            .query()
            .expect("vara flag query")
    }

    fn fund_program_balance(&self, from: u64, value: u128) {
        self.env
            .system()
            .transfer(from, self.program.id(), value, false);
    }

    fn create_basket(
        &self,
        actor: u64,
        asset_kind: BasketAssetKind,
        items: Vec<BasketItem>,
    ) -> u64 {
        block_on(
            self.program
                .basket_market()
                .create_basket("basket".into(), "basket".into(), items, asset_kind)
                .with_actor_id(actor.into()),
        )
        .expect("create basket transport")
    }

    fn create_basket_fails(
        &self,
        actor: u64,
        name: String,
        description: String,
        asset_kind: BasketAssetKind,
        items: Vec<BasketItem>,
    ) {
        let failed = block_on(
            self.program
                .basket_market()
                .create_basket(name, description, items, asset_kind)
                .with_actor_id(actor.into()),
        )
        .is_err();
        assert!(failed);
    }

    fn propose(&self, actor: u64, basket_id: u64, resolutions: Vec<ItemResolution>) {
        block_on(
            self.program
                .basket_market()
                .propose_settlement(basket_id, resolutions, "payload".into())
                .with_actor_id(actor.into()),
        )
        .expect("propose transport");
    }

    fn propose_fails(
        &self,
        actor: u64,
        basket_id: u64,
        resolutions: Vec<ItemResolution>,
        payload: String,
    ) {
        let failed = block_on(
            self.program
                .basket_market()
                .propose_settlement(basket_id, resolutions, payload)
                .with_actor_id(actor.into()),
        )
        .is_err();
        assert!(failed);
    }

    fn set_vara_enabled(&self, actor: u64, enabled: bool) {
        block_on(
            self.program
                .basket_market()
                .set_vara_enabled(enabled)
                .with_actor_id(actor.into()),
        )
        .expect("set vara enabled transport");
    }

    fn set_vara_enabled_fails(&self, actor: u64, enabled: bool) {
        let failed = block_on(
            self.program
                .basket_market()
                .set_vara_enabled(enabled)
                .with_actor_id(actor.into()),
        )
        .is_err();
        assert!(failed);
    }

    fn set_config(&self, actor: u64, config: BasketMarketConfig) {
        block_on(
            self.program
                .basket_market()
                .set_config(config)
                .with_actor_id(actor.into()),
        )
        .expect("set config transport");
    }

    fn set_config_fails(&self, actor: u64, config: BasketMarketConfig) {
        let failed = block_on(
            self.program
                .basket_market()
                .set_config(config)
                .with_actor_id(actor.into()),
        )
        .is_err();
        assert!(failed);
    }

    fn quote_signer_actor(&self) -> ActorId {
        ActorId::from(self.quote_signer.public.to_bytes())
    }

    fn signed_quote(
        &self,
        user: ActorId,
        basket_id: u64,
        amount: u128,
        quoted_index_bps: u16,
        earliest_end_timestamp: u64,
        nonce: u128,
    ) -> SignedVaraBetQuote {
        let payload = VaraBetQuotePayload {
            target_program_id: self.program.id().into(),
            user,
            basket_id,
            amount,
            quoted_index_bps,
            earliest_end_timestamp,
            deadline_ms: FUTURE_END,
            nonce,
        };
        let message = [
            b"<Bytes>".to_vec(),
            [b"BasketMarketVaraQuoteV1".encode(), payload.encode()].concat(),
            b"</Bytes>".to_vec(),
        ]
        .concat();
        let signature = self
            .quote_signer
            .sign(signing_context(b"substrate").bytes(&message))
            .to_bytes()
            .to_vec();

        SignedVaraBetQuote { payload, signature }
    }
}

fn single_item(outcome: Outcome) -> Vec<BasketItem> {
    vec![BasketItem {
        poly_market_id: "market-1".into(),
        poly_slug: "market-1".into(),
        weight_bps: 10_000,
        selected_outcome: outcome,
        end_timestamp: FUTURE_END,
    }]
}

fn two_items() -> Vec<BasketItem> {
    vec![
        BasketItem {
            poly_market_id: "market-1".into(),
            poly_slug: "market-1".into(),
            weight_bps: 5_000,
            selected_outcome: Outcome::YES,
            end_timestamp: FUTURE_END,
        },
        BasketItem {
            poly_market_id: "market-2".into(),
            poly_slug: "market-2".into(),
            weight_bps: 5_000,
            selected_outcome: Outcome::NO,
            end_timestamp: FUTURE_END,
        },
    ]
}

fn duplicated_items() -> Vec<BasketItem> {
    vec![
        BasketItem {
            poly_market_id: "market-1".into(),
            poly_slug: "market-1".into(),
            weight_bps: 5_000,
            selected_outcome: Outcome::YES,
            end_timestamp: FUTURE_END,
        },
        BasketItem {
            poly_market_id: "market-1".into(),
            poly_slug: "market-1-duplicate".into(),
            weight_bps: 5_000,
            selected_outcome: Outcome::YES,
            end_timestamp: FUTURE_END,
        },
    ]
}

fn single_resolution() -> Vec<ItemResolution> {
    vec![ItemResolution {
        item_index: 0,
        resolved: Outcome::YES,
        poly_slug: "market-1".into(),
        poly_condition_id: None,
        poly_price_yes: 10_000,
        poly_price_no: 0,
    }]
}

fn two_resolutions() -> Vec<ItemResolution> {
    vec![
        ItemResolution {
            item_index: 0,
            resolved: Outcome::YES,
            poly_slug: "market-1".into(),
            poly_condition_id: None,
            poly_price_yes: 10_000,
            poly_price_no: 0,
        },
        ItemResolution {
            item_index: 1,
            resolved: Outcome::NO,
            poly_slug: "market-2".into(),
            poly_condition_id: None,
            poly_price_yes: 0,
            poly_price_no: 10_000,
        },
    ]
}

#[test]
fn default_config_is_chip_only() {
    let harness = Harness::new(1_000);

    let config = harness
        .program
        .basket_market()
        .get_config()
        .query()
        .expect("config query");

    assert_eq!(
        config,
        BasketMarketConfig {
            admin_role: ADMIN.into(),
            settler_role: SETTLER.into(),
            liveness_ms: 1_000,
            vara_enabled: false,
            min_items_per_basket: 2,
            quote_signer: harness.quote_signer_actor(),
            bet_cutoff_ms: 60_000,
        }
    );
    assert!(!harness.vara_enabled());
}

#[test]
fn only_admin_can_toggle_vara_support() {
    let harness = Harness::new(1_000);

    harness.set_vara_enabled_fails(SETTLER, true);
    assert!(!harness.vara_enabled());

    harness.set_vara_enabled_fails(OTHER_USER, true);
    assert!(!harness.vara_enabled());

    harness.set_vara_enabled(ADMIN, true);
    assert!(harness.vara_enabled());
}

#[test]
fn admin_can_replace_runtime_config_and_handover_admin_role() {
    let harness = Harness::new(1_000);

    harness.set_config_fails(
        SETTLER,
        BasketMarketConfig {
            admin_role: OTHER_USER.into(),
            settler_role: USER.into(),
            liveness_ms: 12_345,
            vara_enabled: true,
            min_items_per_basket: 2,
            quote_signer: harness.quote_signer_actor(),
            bet_cutoff_ms: 60_000,
        },
    );

    harness.set_config(
        ADMIN,
        BasketMarketConfig {
            admin_role: OTHER_USER.into(),
            settler_role: USER.into(),
            liveness_ms: 12_345,
            vara_enabled: true,
            min_items_per_basket: 2,
            quote_signer: harness.quote_signer_actor(),
            bet_cutoff_ms: 60_000,
        },
    );

    let config = harness
        .program
        .basket_market()
        .get_config()
        .query()
        .expect("config query after update");
    assert_eq!(
        config,
        BasketMarketConfig {
            admin_role: OTHER_USER.into(),
            settler_role: USER.into(),
            liveness_ms: 12_345,
            vara_enabled: true,
            min_items_per_basket: 2,
            quote_signer: harness.quote_signer_actor(),
            bet_cutoff_ms: 60_000,
        }
    );

    harness.set_vara_enabled_fails(ADMIN, false);
    harness.set_vara_enabled(OTHER_USER, false);
    assert!(!harness.vara_enabled());
}

#[test]
fn config_update_rejects_zero_roles() {
    let harness = Harness::new(1_000);

    harness.set_config_fails(
        ADMIN,
        BasketMarketConfig {
            admin_role: ActorId::zero(),
            settler_role: SETTLER.into(),
            liveness_ms: 1_000,
            vara_enabled: false,
            min_items_per_basket: 2,
            quote_signer: harness.quote_signer_actor(),
            bet_cutoff_ms: 60_000,
        },
    );

    harness.set_config_fails(
        ADMIN,
        BasketMarketConfig {
            admin_role: ADMIN.into(),
            settler_role: ActorId::zero(),
            liveness_ms: 1_000,
            vara_enabled: false,
            min_items_per_basket: 2,
            quote_signer: harness.quote_signer_actor(),
            bet_cutoff_ms: 60_000,
        },
    );

    harness.set_config_fails(
        ADMIN,
        BasketMarketConfig {
            admin_role: ADMIN.into(),
            settler_role: SETTLER.into(),
            liveness_ms: 1_000,
            vara_enabled: false,
            min_items_per_basket: 0,
            quote_signer: harness.quote_signer_actor(),
            bet_cutoff_ms: 60_000,
        },
    );
}

#[test]
fn create_basket_respects_vara_toggle() {
    let harness = Harness::new(1_000);

    harness.create_basket_fails(
        USER,
        "basket".into(),
        "basket".into(),
        BasketAssetKind::Vara,
        single_item(Outcome::YES),
    );
    assert_eq!(harness.basket_count(), 0);

    let ft_basket_id = harness.create_basket(USER, BasketAssetKind::Bet, two_items());
    assert_eq!(ft_basket_id, 0);

    harness.set_vara_enabled(ADMIN, true);
    let vara_basket_id = harness.create_basket(USER, BasketAssetKind::Vara, two_items());
    assert_eq!(vara_basket_id, 1);
}

#[test]
fn duplicate_basket_items_are_rejected_on_chain() {
    let harness = Harness::new(1_000);

    harness.create_basket_fails(
        USER,
        "basket".into(),
        "basket".into(),
        BasketAssetKind::Bet,
        duplicated_items(),
    );
    assert_eq!(harness.basket_count(), 0);
}

#[test]
fn basket_requires_configured_minimum_item_count() {
    let harness = Harness::new(1_000);

    harness.create_basket_fails(
        USER,
        "basket".into(),
        "basket".into(),
        BasketAssetKind::Bet,
        single_item(Outcome::YES),
    );
    assert_eq!(harness.basket_count(), 0);

    harness.set_config(
        ADMIN,
        BasketMarketConfig {
            admin_role: ADMIN.into(),
            settler_role: SETTLER.into(),
            liveness_ms: 1_000,
            vara_enabled: false,
            min_items_per_basket: 1,
            quote_signer: harness.quote_signer_actor(),
            bet_cutoff_ms: 60_000,
        },
    );

    let basket_id = harness.create_basket(USER, BasketAssetKind::Bet, single_item(Outcome::YES));
    assert_eq!(basket_id, 0);
}

#[test]
fn basket_and_payload_size_limits_are_enforced() {
    let harness = Harness::new(1_000);

    harness.create_basket_fails(
        USER,
        "n".repeat(129),
        "description".into(),
        BasketAssetKind::Bet,
        single_item(Outcome::YES),
    );
    assert_eq!(harness.basket_count(), 0);

    let basket_id = harness.create_basket(USER, BasketAssetKind::Bet, two_items());
    harness.propose_fails(SETTLER, basket_id, single_resolution(), "p".repeat(4_097));
}

#[test]
fn native_vara_bet_is_rejected_when_disabled_or_for_ft_basket() {
    let harness = Harness::new(1_000);

    harness.set_vara_enabled(ADMIN, true);
    let vara_basket_id = harness.create_basket(USER, BasketAssetKind::Vara, two_items());
    let ft_basket_id = harness.create_basket(USER, BasketAssetKind::Bet, two_items());

    harness.set_vara_enabled(ADMIN, false);
    let disabled_bet = block_on(
        harness
            .program
            .basket_market()
            .bet_on_basket(
                vara_basket_id,
                harness.signed_quote(USER.into(), vara_basket_id, 1_000, 10_000, FUTURE_END, 1),
            )
            .with_actor_id(USER.into())
            .with_value(1_000),
    )
    .is_err();
    assert!(disabled_bet);

    harness.set_vara_enabled(ADMIN, true);
    let ft_native_bet = block_on(
        harness
            .program
            .basket_market()
            .bet_on_basket(
                ft_basket_id,
                harness.signed_quote(USER.into(), ft_basket_id, 1_000, 10_000, FUTURE_END, 2),
            )
            .with_actor_id(USER.into())
            .with_value(1_000),
    )
    .is_err();
    assert!(ft_native_bet);
}

#[test]
fn betting_is_locked_after_settlement_proposal() {
    let harness = Harness::new(1_000);

    harness.set_vara_enabled(ADMIN, true);
    let basket_id = harness.create_basket(USER, BasketAssetKind::Vara, two_items());
    harness.propose(SETTLER, basket_id, two_resolutions());

    let basket: Basket = harness
        .program
        .basket_market()
        .get_basket(basket_id)
        .query()
        .expect("basket query")
        .expect("basket result");
    assert_eq!(basket.status, BasketStatus::SettlementPending);

    let bet_after_proposal = block_on(
        harness
            .program
            .basket_market()
            .bet_on_basket(
                basket_id,
                harness.signed_quote(USER.into(), basket_id, 1_000, 10_000, FUTURE_END, 3),
            )
            .with_actor_id(USER.into())
            .with_value(1_000),
    )
    .is_err();
    assert!(bet_after_proposal);
}

#[test]
fn settlement_validation_rejects_duplicate_item_indexes() {
    let harness = Harness::new(1_000);
    let basket_id = harness.create_basket(USER, BasketAssetKind::Bet, two_items());

    let duplicate_indices = vec![
        ItemResolution {
            item_index: 0,
            resolved: Outcome::YES,
            poly_slug: "market-1".into(),
            poly_condition_id: None,
            poly_price_yes: 10_000,
            poly_price_no: 0,
        },
        ItemResolution {
            item_index: 0,
            resolved: Outcome::NO,
            poly_slug: "market-1".into(),
            poly_condition_id: None,
            poly_price_yes: 0,
            poly_price_no: 10_000,
        },
    ];

    harness.propose_fails(SETTLER, basket_id, duplicate_indices, "payload".into());
}

#[test]
fn settlement_validation_rejects_wrong_resolution_count() {
    let harness = Harness::new(1_000);
    let basket_id = harness.create_basket(USER, BasketAssetKind::Bet, two_items());

    harness.propose_fails(SETTLER, basket_id, single_resolution(), "payload".into());
}

#[test]
fn settlement_validation_rejects_slug_mismatch() {
    let harness = Harness::new(1_000);
    let basket_id = harness.create_basket(USER, BasketAssetKind::Bet, two_items());

    let mismatched = vec![
        ItemResolution {
            item_index: 0,
            resolved: Outcome::YES,
            poly_slug: "wrong-slug".into(),
            poly_condition_id: None,
            poly_price_yes: 10_000,
            poly_price_no: 0,
        },
        ItemResolution {
            item_index: 1,
            resolved: Outcome::NO,
            poly_slug: "market-2".into(),
            poly_condition_id: None,
            poly_price_yes: 0,
            poly_price_no: 10_000,
        },
    ];

    harness.propose_fails(SETTLER, basket_id, mismatched, "payload".into());
}

#[test]
fn finalize_before_deadline_is_rejected() {
    let harness = Harness::new(10_000);

    let basket_id = harness.create_basket(USER, BasketAssetKind::Bet, two_items());
    harness.propose(SETTLER, basket_id, two_resolutions());

    let finalize_failed = block_on(
        harness
            .program
            .basket_market()
            .finalize_settlement(basket_id)
            .with_actor_id(USER.into()),
    )
    .is_err();
    assert!(finalize_failed);
}

#[test]
fn claim_requires_finalized_vara_settlement() {
    let harness = Harness::new(1_000);

    harness.set_vara_enabled(ADMIN, true);
    let basket_id = harness.create_basket(USER, BasketAssetKind::Vara, two_items());
    let bet = block_on(
        harness
            .program
            .basket_market()
            .bet_on_basket(
                basket_id,
                harness.signed_quote(USER.into(), basket_id, 1_000, 10_000, FUTURE_END, 4),
            )
            .with_actor_id(USER.into())
            .with_value(1_000),
    )
    .expect("bet transport");
    assert_eq!(bet, 1_000);

    harness.propose(SETTLER, basket_id, two_resolutions());

    let premature_claim = block_on(
        harness
            .program
            .basket_market()
            .claim(basket_id)
            .with_actor_id(USER.into()),
    )
    .is_err();
    assert!(premature_claim);
}

#[test]
fn claim_is_rejected_for_ft_baskets() {
    let harness = Harness::new(1_000);

    let basket_id = harness.create_basket(USER, BasketAssetKind::Bet, two_items());
    let claim_failed = block_on(
        harness
            .program
            .basket_market()
            .claim(basket_id)
            .with_actor_id(USER.into()),
    )
    .is_err();
    assert!(claim_failed);
}

#[test]
fn existing_vara_positions_can_claim_after_disable_but_not_twice() {
    let harness = Harness::new(0);

    harness.set_vara_enabled(ADMIN, true);
    let basket_id = harness.create_basket(USER, BasketAssetKind::Vara, two_items());
    let bet = block_on(
        harness
            .program
            .basket_market()
            .bet_on_basket(
                basket_id,
                harness.signed_quote(USER.into(), basket_id, 1_000, 10_000, FUTURE_END, 5),
            )
            .with_actor_id(USER.into())
            .with_value(1_000),
    )
    .expect("bet transport");
    assert_eq!(bet, 1_000);

    harness.propose(SETTLER, basket_id, two_resolutions());
    harness.set_vara_enabled(ADMIN, false);
    harness.advance_blocks(1);

    block_on(
        harness
            .program
            .basket_market()
            .finalize_settlement(basket_id)
            .with_actor_id(OTHER_USER.into()),
    )
    .expect("finalize transport");

    let settlement = harness
        .program
        .basket_market()
        .get_settlement(basket_id)
        .query()
        .expect("settlement query")
        .expect("settlement result");
    assert_eq!(settlement.status, SettlementStatus::Finalized);

    let payout = block_on(
        harness
            .program
            .basket_market()
            .claim(basket_id)
            .with_actor_id(USER.into()),
    )
    .expect("claim transport");
    assert_eq!(payout, 1_000);

    let double_claim_failed = block_on(
        harness
            .program
            .basket_market()
            .claim(basket_id)
            .with_actor_id(USER.into()),
    )
    .is_err();
    assert!(double_claim_failed);
}

#[test]
fn admin_can_withdraw_vara_from_program_balance_without_pause() {
    let harness = Harness::new(0);
    let program_id = harness.program.id();
    let initial_program_balance = harness.env.system().balance_of(program_id);

    harness.fund_program_balance(ADMIN, 5_000);

    let non_admin_failed = block_on(
        harness
            .program
            .basket_market()
            .admin_withdraw_vara(OTHER_USER.into(), 1_000)
            .with_actor_id(USER.into()),
    )
    .is_err();
    assert!(non_admin_failed);

    let zero_failed = block_on(
        harness
            .program
            .basket_market()
            .admin_withdraw_vara(OTHER_USER.into(), 0)
            .with_actor_id(ADMIN.into()),
    )
    .is_err();
    assert!(zero_failed);

    let withdrawn = block_on(
        harness
            .program
            .basket_market()
            .admin_withdraw_vara(OTHER_USER.into(), 1_500)
            .with_actor_id(ADMIN.into()),
    )
    .expect("admin withdraw should succeed");
    assert_eq!(withdrawn, 1_500);
    harness.advance_blocks(1);

    assert_eq!(
        harness.env.system().balance_of(program_id),
        initial_program_balance + 3_500
    );
}
