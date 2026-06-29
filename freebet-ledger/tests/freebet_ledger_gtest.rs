use freebet_ledger::WASM_BINARY as FREEBET_LEDGER_WASM_BINARY;
use freebet_ledger_client::{
    FreebetLedger, FreebetLedgerCtors, FreebetLedgerInit, FreebetLedgerProgram,
    SignedVaraBetQuote, VaraBetQuotePayload,
    freebet_ledger::FreebetLedger as FreebetLedgerService,
};
use futures::executor::block_on;
use gtest::System;
use polymarket_mirror::WASM_BINARY as POLYMARKET_MIRROR_WASM_BINARY;
use polymarket_mirror_client::{
    BasketAssetKind, BasketItem, BasketMarketInit, ItemResolution, Outcome, PolymarketMirror,
    PolymarketMirrorCtors, PolymarketMirrorProgram, basket_market::BasketMarket,
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
const QUOTE_SEED: [u8; 32] = [9; 32];
const FUTURE_END: u64 = 1_900_000_000_000;

struct Harness {
    env: GtestEnv,
    mirror: sails_rs::client::Actor<PolymarketMirrorProgram, GtestEnv>,
    ledger: sails_rs::client::Actor<FreebetLedgerProgram, GtestEnv>,
    quote_signer: schnorrkel::Keypair,
}

impl Harness {
    fn new() -> Self {
        let system = System::new();
        system.mint_to(ADMIN, TEST_BALANCE);
        system.mint_to(SETTLER, TEST_BALANCE);
        system.mint_to(USER, TEST_BALANCE);
        system.mint_to(OTHER_USER, TEST_BALANCE);

        let mirror_code_id = system.submit_code(POLYMARKET_MIRROR_WASM_BINARY);
        let ledger_code_id = system.submit_code(FREEBET_LEDGER_WASM_BINARY);
        let env = GtestEnv::new(system, ADMIN.into());
        let quote_signer = MiniSecretKey::from_bytes(&QUOTE_SEED)
            .expect("test quote seed")
            .expand_to_keypair(ExpansionMode::Ed25519);
        let quote_signer_actor = ActorId::from(quote_signer.public.to_bytes());

        let mirror = block_on(
            PolymarketMirrorProgram::deploy(mirror_code_id, b"freebet-ledger-mirror".to_vec())
                .with_env(&env)
                .new(BasketMarketInit {
                    admin_role: ADMIN.into(),
                    settler_role: SETTLER.into(),
                    liveness_ms: 1,
                    quote_signer: quote_signer_actor,
                    bet_cutoff_ms: 60_000,
                }),
        )
        .expect("mirror deploy");

        let ledger = block_on(
            FreebetLedgerProgram::deploy(ledger_code_id, b"freebet-ledger".to_vec())
                .with_env(&env)
                .new(FreebetLedgerInit {
                    admin: ADMIN.into(),
                }),
        )
        .expect("ledger deploy");

        let harness = Self {
            env,
            mirror,
            ledger,
            quote_signer,
        };
        harness.configure();
        harness
    }

    fn configure(&self) {
        block_on(
            self.mirror
                .basket_market()
                .set_vara_enabled(true)
                .with_actor_id(ADMIN.into()),
        )
        .expect("enable vara");
        block_on(
            self.mirror
                .basket_market()
                .set_freebet_ledger(self.ledger.id())
                .with_actor_id(ADMIN.into()),
        )
        .expect("set ledger");
        block_on(
            self.ledger
                .freebet_ledger()
                .authorize_bet_program(self.mirror.id())
                .with_actor_id(ADMIN.into()),
        )
        .expect("authorize mirror");
    }

    fn advance_blocks(&self, blocks: u32) {
        let next_block = self.env.system().block_height().saturating_add(blocks);
        self.env.system().run_to_block(next_block);
    }

    fn create_basket(&self, asset_kind: BasketAssetKind) -> u64 {
        block_on(
            self.mirror
                .basket_market()
                .create_basket("basket".into(), "basket".into(), two_items(), asset_kind)
                .with_actor_id(USER.into()),
        )
        .expect("create basket")
    }

    fn grant(&self, grant_id: &str, amount: u128) -> u128 {
        block_on(
            self.ledger
                .freebet_ledger()
                .grant(USER.into(), grant_id.into(), "task reward".into())
                .with_actor_id(ADMIN.into())
                .with_value(amount),
        )
        .expect("grant")
    }

    fn balance_of(&self, user: u64) -> u128 {
        self.ledger
            .freebet_ledger()
            .balance_of(user.into())
            .query()
            .expect("ledger balance")
    }

    fn signed_quote(
        &self,
        user: ActorId,
        basket_id: u64,
        amount: u128,
        quoted_index_bps: u16,
        nonce: u128,
    ) -> SignedVaraBetQuote {
        let payload = VaraBetQuotePayload {
            target_program_id: self.mirror.id().into(),
            user,
            basket_id,
            amount,
            quoted_index_bps,
            earliest_end_timestamp: FUTURE_END,
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

    fn spend(&self, basket_id: u64, amount: u128, index_at_creation_bps: u16) -> u128 {
        block_on(
            self.ledger
                .freebet_ledger()
                .spend_freebet(
                    self.mirror.id(),
                    basket_id,
                    amount,
                    self.signed_quote(USER.into(), basket_id, amount, index_at_creation_bps, 1),
                )
                .with_actor_id(USER.into()),
        )
        .expect("spend freebet")
    }

    fn finalize(&self, basket_id: u64, resolutions: Vec<ItemResolution>) {
        block_on(
            self.mirror
                .basket_market()
                .propose_settlement(basket_id, resolutions, "payload".into())
                .with_actor_id(SETTLER.into()),
        )
        .expect("propose");
        self.advance_blocks(1);
        block_on(
            self.mirror
                .basket_market()
                .finalize_settlement(basket_id)
                .with_actor_id(OTHER_USER.into()),
        )
        .expect("finalize");
    }

    fn fund_mirror(&self, amount: u128) {
        self.env
            .system()
            .transfer(ADMIN, self.mirror.id(), amount, false);
    }
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
            selected_outcome: Outcome::YES,
            end_timestamp: FUTURE_END,
        },
    ]
}

fn full_win() -> Vec<ItemResolution> {
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
            resolved: Outcome::YES,
            poly_slug: "market-2".into(),
            poly_condition_id: None,
            poly_price_yes: 10_000,
            poly_price_no: 0,
        },
    ]
}

fn half_win() -> Vec<ItemResolution> {
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
fn grant_is_backed_by_native_vara_and_idempotent() {
    let harness = Harness::new();
    let initial_ledger_native = harness.env.system().balance_of(harness.ledger.id());

    let balance = harness.grant("task:x:user:1", 1_500);
    assert_eq!(balance, 1_500);
    assert_eq!(harness.balance_of(USER), 1_500);
    assert_eq!(
        harness.env.system().balance_of(harness.ledger.id()),
        initial_ledger_native + 1_500
    );

    let duplicate = block_on(
        harness
            .ledger
            .freebet_ledger()
            .grant(USER.into(), "task:x:user:1".into(), "task reward".into())
            .with_actor_id(ADMIN.into())
            .with_value(1_500),
    )
    .is_err();
    assert!(duplicate);
    assert_eq!(harness.balance_of(USER), 1_500);
}

#[test]
fn spend_moves_vara_from_ledger_to_basket_market_and_records_position() {
    let harness = Harness::new();
    let basket_id = harness.create_basket(BasketAssetKind::Vara);
    let initial_ledger_native = harness.env.system().balance_of(harness.ledger.id());
    let initial_mirror_native = harness.env.system().balance_of(harness.mirror.id());

    harness.grant("task:x:user:2", 1_500);
    let spent = harness.spend(basket_id, 1_000, 10_000);
    assert_eq!(spent, 1_000);

    assert_eq!(harness.balance_of(USER), 500);
    assert_eq!(
        harness.env.system().balance_of(harness.ledger.id()),
        initial_ledger_native + 500
    );
    assert_eq!(
        harness.env.system().balance_of(harness.mirror.id()),
        initial_mirror_native + 1_000
    );

    let positions = harness
        .mirror
        .basket_market()
        .get_freebet_positions(USER.into())
        .query()
        .expect("freebet positions");
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0].basket_id, basket_id);
    assert_eq!(positions[0].shares, 1_000);
}

#[test]
fn failed_downstream_spend_restores_ledger_balance() {
    let harness = Harness::new();
    let bet_basket_id = harness.create_basket(BasketAssetKind::Bet);

    harness.grant("task:x:user:3", 1_000);
    let spent = block_on(
        harness
            .ledger
            .freebet_ledger()
            .spend_freebet(
                harness.mirror.id(),
                bet_basket_id,
                1_000,
                harness.signed_quote(USER.into(), bet_basket_id, 1_000, 10_000, 2),
            )
            .with_actor_id(USER.into()),
    )
    .expect("failed downstream spend should commit refund");
    assert_eq!(spent, 0);

    assert_eq!(harness.balance_of(USER), 1_000);
    assert_eq!(
        harness
            .ledger
            .freebet_ledger()
            .get_pending_spend_count()
            .query()
            .expect("pending count"),
        0
    );
}

#[test]
fn unauthorized_program_cannot_receive_freebet_spend() {
    let harness = Harness::new();
    let basket_id = harness.create_basket(BasketAssetKind::Vara);
    harness.grant("task:x:user:4", 1_000);

    block_on(
        harness
            .ledger
            .freebet_ledger()
            .revoke_bet_program(harness.mirror.id())
            .with_actor_id(ADMIN.into()),
    )
    .expect("revoke");

    let failed = block_on(
        harness
            .ledger
            .freebet_ledger()
            .spend_freebet(
                harness.mirror.id(),
                basket_id,
                1_000,
                harness.signed_quote(USER.into(), basket_id, 1_000, 10_000, 3),
            )
            .with_actor_id(USER.into()),
    )
    .is_err();
    assert!(failed);
    assert_eq!(harness.balance_of(USER), 1_000);
}

#[test]
fn winning_claim_returns_principal_to_ledger_and_profit_to_user() {
    let harness = Harness::new();
    let basket_id = harness.create_basket(BasketAssetKind::Vara);
    harness.grant("task:x:user:5", 1_000);
    harness.spend(basket_id, 1_000, 5_000);
    harness.fund_mirror(1_000);
    harness.finalize(basket_id, full_win());

    let ledger_native_before_claim = harness.env.system().balance_of(harness.ledger.id());
    let payout = block_on(
        harness
            .mirror
            .basket_market()
            .claim(basket_id)
            .with_actor_id(USER.into()),
    )
    .expect("claim");
    harness.advance_blocks(1);

    assert_eq!(payout, 1_000);
    assert_eq!(harness.balance_of(USER), 1_000);
    assert_eq!(
        harness.env.system().balance_of(harness.ledger.id()),
        ledger_native_before_claim + 1_000
    );
}

#[test]
fn partial_claim_returns_only_gross_to_ledger_without_user_profit() {
    let harness = Harness::new();
    let basket_id = harness.create_basket(BasketAssetKind::Vara);
    harness.grant("task:x:user:6", 1_000);
    harness.spend(basket_id, 1_000, 10_000);
    harness.finalize(basket_id, half_win());

    let payout = block_on(
        harness
            .mirror
            .basket_market()
            .claim(basket_id)
            .with_actor_id(USER.into()),
    )
    .expect("claim");

    assert_eq!(payout, 0);
    assert_eq!(harness.balance_of(USER), 500);
}
