use awesome_sails_vft_admin::MINTER_ROLE;
use bet_lane::WASM_BINARY as BET_LANE_WASM_BINARY;
use bet_lane_client::{
    BetLaneClient, BetLaneClientCtors, BetLaneConfig, BetLaneDependencies, BetQuotePayload,
    ImportedPosition, ImportedQuoteNonce, SignedBetQuote, bet_lane::BetLane,
};
use bet_token::WASM_BINARY as BET_TOKEN_WASM_BINARY;
use bet_token_client::{
    BetTokenClient, BetTokenClientCtors, bet_token::BetToken, vft_admin::VftAdmin,
};
use gtest::System;
use gtest::constants::{DEFAULT_USER_ALICE, DEFAULT_USER_BOB, DEFAULT_USER_CHARLIE};
use polymarket_mirror::WASM_BINARY as POLYMARKET_MIRROR_WASM_BINARY;
use polymarket_mirror_client::{
    BasketAssetKind, BasketItem, BasketMarketInit, ItemResolution, Outcome, PolymarketMirror,
    PolymarketMirrorCtors, basket_market::BasketMarket,
};
use sails_rs::client::{GearEnv, GtestEnv};
use sails_rs::{
    Encode,
    prelude::{ActorId, U256},
};
use schnorrkel::{ExpansionMode, Keypair, MiniSecretKey, signing_context};

const TOKEN_NAME: &str = "Bet Token";
const TOKEN_SYMBOL: &str = "BET";
const TOKEN_DECIMALS: u8 = 12;
const VALID_QUOTE_DEADLINE_MS: u64 = 9_999_999_999_999;

struct Harness {
    env: GtestEnv,
    mirror: sails_rs::client::Actor<polymarket_mirror_client::PolymarketMirrorProgram, GtestEnv>,
    bet_token: sails_rs::client::Actor<bet_token_client::BetTokenClientProgram, GtestEnv>,
    bet_lane: sails_rs::client::Actor<bet_lane_client::BetLaneClientProgram, GtestEnv>,
    admin: ActorId,
    alice: ActorId,
    bob: ActorId,
    quote_signer: Keypair,
}

impl Harness {
    async fn new() -> Self {
        Self::new_with_lane_config(None).await
    }

    async fn new_with_lane_config(config: Option<BetLaneConfig>) -> Self {
        let system = System::new();
        system.init_logger();

        let admin = ActorId::from(DEFAULT_USER_ALICE);
        let alice = ActorId::from(DEFAULT_USER_BOB);
        let bob = ActorId::from(DEFAULT_USER_CHARLIE);
        let quote_signer = keypair_from_seed([7u8; 32]);
        let lane_config = match config {
            Some(config) => BetLaneConfig {
                quote_signer: ActorId::from(quote_signer.public.to_bytes()),
                ..config
            },
            None => BetLaneConfig {
                min_bet: U256::from(10u32),
                max_bet: U256::from(10_000u32),
                payouts_allowed_while_paused: true,
                quote_signer: ActorId::from(quote_signer.public.to_bytes()),
            },
        };

        let env = GtestEnv::new(system, admin);

        let mirror_code_id = env.system().submit_code(POLYMARKET_MIRROR_WASM_BINARY);
        let mirror = env
            .deploy(mirror_code_id, b"polymarket-mirror".to_vec())
            .new(BasketMarketInit {
                admin_role: admin,
                settler_role: admin,
                liveness_ms: 1,
            })
            .await
            .expect("mirror deployment should succeed");

        let token_code_id = env.system().submit_code(BET_TOKEN_WASM_BINARY);
        let bet_token_deployment: sails_rs::client::Deployment<
            bet_token_client::BetTokenClientProgram,
            GtestEnv,
        > = env.deploy(token_code_id, b"bet-token".to_vec());
        let bet_token = bet_token_deployment
            .create(
                admin,
                TOKEN_NAME.into(),
                TOKEN_SYMBOL.into(),
                TOKEN_DECIMALS,
                None,
            )
            .await
            .expect("bet-token deployment should succeed");

        let lane_code_id = env.system().submit_code(BET_LANE_WASM_BINARY);
        let bet_lane_deployment: sails_rs::client::Deployment<
            bet_lane_client::BetLaneClientProgram,
            GtestEnv,
        > = env.deploy(lane_code_id, b"bet-lane".to_vec());
        let bet_lane = bet_lane_deployment
            .create(admin, mirror.id(), bet_token.id(), Some(lane_config))
            .await
            .expect("bet-lane deployment should succeed");

        let mut token_service = bet_token.bet_token();
        token_service
            .allow_spender(bet_lane.id())
            .with_actor_id(admin)
            .await
            .expect("bet-lane program should be whitelisted as spender");
        token_service
            .grant_role(MINTER_ROLE, admin)
            .with_actor_id(admin)
            .await
            .expect("admin should get MINTER_ROLE");

        Self {
            env,
            mirror,
            bet_token,
            bet_lane,
            admin,
            alice,
            bob,
            quote_signer,
        }
    }

    fn advance_blocks(&self, blocks: u32) {
        let next_block = self.env.system().block_height().saturating_add(blocks);
        self.env.system().run_to_block(next_block);
    }

    async fn mint(&self, to: ActorId, amount: u32) {
        let mut admin = self.bet_token.vft_admin();
        admin
            .mint(to, U256::from(amount))
            .with_actor_id(self.admin)
            .await
            .expect("mint should succeed");
    }

    async fn approve_lane(&self, actor: ActorId, amount: u32) {
        let mut token = self.bet_token.bet_token();
        token
            .approve(self.bet_lane.id(), U256::from(amount))
            .with_actor_id(actor)
            .await
            .expect("approve should succeed");
    }

    async fn create_basket(&self, asset_kind: BasketAssetKind) -> u64 {
        let mut mirror = self.mirror.basket_market();
        mirror
            .create_basket(
                "Basket #1".into(),
                "Companion BET lane".into(),
                vec![
                    BasketItem {
                        poly_market_id: "market-1".into(),
                        poly_slug: "market-1".into(),
                        weight_bps: 5_000,
                        selected_outcome: Outcome::YES,
                    },
                    BasketItem {
                        poly_market_id: "market-2".into(),
                        poly_slug: "market-2".into(),
                        weight_bps: 5_000,
                        selected_outcome: Outcome::YES,
                    },
                ],
                asset_kind,
            )
            .with_actor_id(self.admin)
            .await
            .expect("create basket transport should succeed")
    }

    async fn finalize_yes_settlement(&self, basket_id: u64) {
        let mut mirror = self.mirror.basket_market();
        mirror
            .propose_settlement(
                basket_id,
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
                ],
                "{\"source\":\"gtest\"}".into(),
            )
            .with_actor_id(self.admin)
            .await
            .expect("propose settlement transport should succeed");

        self.advance_blocks(1);

        mirror
            .finalize_settlement(basket_id)
            .with_actor_id(self.admin)
            .await
            .expect("finalize settlement transport should succeed");
    }

    async fn bet_token_balance(&self, actor: ActorId) -> U256 {
        self.bet_token
            .bet_token()
            .balance_of(actor)
            .await
            .expect("balance query should succeed")
    }

    fn signed_quote(
        &self,
        user: ActorId,
        basket_id: u64,
        amount: U256,
        quoted_index_bps: u16,
        deadline_ms: u64,
        nonce: u128,
    ) -> SignedBetQuote {
        let payload = BetQuotePayload {
            target_program_id: self.bet_lane.id(),
            user,
            basket_id,
            amount,
            quoted_index_bps,
            deadline_ms,
            nonce,
        };
        let message = [
            b"<Bytes>".to_vec(),
            [b"BetLaneQuoteV1".encode(), payload.encode()].concat(),
            b"</Bytes>".to_vec(),
        ]
        .concat();
        let signature = self
            .quote_signer
            .sign(signing_context(b"substrate").bytes(&message))
            .to_bytes()
            .to_vec();

        SignedBetQuote { payload, signature }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn bet_lane_matches_native_index_payout_formula() {
    let harness = Harness::new().await;
    let basket_id = harness.create_basket(BasketAssetKind::Bet).await;

    harness.mint(harness.alice, 100).await;
    harness.approve_lane(harness.alice, 100).await;

    let mut lane = harness.bet_lane.bet_lane();
    let quote = harness.signed_quote(
        harness.alice,
        basket_id,
        U256::from(100u32),
        5_000,
        VALID_QUOTE_DEADLINE_MS,
        1,
    );
    let minted_shares = lane
        .place_bet(basket_id, U256::from(100u32), quote)
        .with_actor_id(harness.alice)
        .await
        .expect("place bet should succeed");
    assert_eq!(minted_shares, U256::from(100u32));

    let alice_balance_after_bet = harness.bet_token_balance(harness.alice).await;
    let lane_balance_after_bet = harness.bet_token_balance(harness.bet_lane.id()).await;
    let position_after_bet = lane
        .get_position(harness.alice, basket_id)
        .await
        .expect("position query should succeed");

    assert_eq!(alice_balance_after_bet, U256::zero());
    assert_eq!(lane_balance_after_bet, U256::from(100u32));
    assert_eq!(position_after_bet.shares, U256::from(100u32));
    assert_eq!(position_after_bet.index_at_creation_bps, 5_000);
    assert!(!position_after_bet.claimed);

    harness.mint(harness.bet_lane.id(), 100).await;
    harness.finalize_yes_settlement(basket_id).await;

    let payout = lane
        .claim(basket_id)
        .with_actor_id(harness.alice)
        .await
        .expect("claim should succeed");
    assert_eq!(payout, U256::from(200u32));

    let alice_balance_after_claim = harness.bet_token_balance(harness.alice).await;
    let lane_balance_after_claim = harness.bet_token_balance(harness.bet_lane.id()).await;
    let position_after_claim = lane
        .get_position(harness.alice, basket_id)
        .await
        .expect("position query should succeed");

    assert_eq!(alice_balance_after_claim, U256::from(200u32));
    assert_eq!(lane_balance_after_claim, U256::zero());
    assert!(position_after_claim.claimed);
}

#[tokio::test(flavor = "current_thread")]
async fn repeated_entries_merge_into_weighted_average_index() {
    let harness = Harness::new().await;
    let basket_id = harness.create_basket(BasketAssetKind::Bet).await;

    harness.mint(harness.alice, 200).await;
    harness.approve_lane(harness.alice, 200).await;

    let mut lane = harness.bet_lane.bet_lane();
    let first_quote = harness.signed_quote(
        harness.alice,
        basket_id,
        U256::from(100u32),
        4_000,
        VALID_QUOTE_DEADLINE_MS,
        1,
    );
    lane.place_bet(basket_id, U256::from(100u32), first_quote)
        .with_actor_id(harness.alice)
        .await
        .expect("first bet should succeed");
    let second_quote = harness.signed_quote(
        harness.alice,
        basket_id,
        U256::from(100u32),
        8_000,
        VALID_QUOTE_DEADLINE_MS,
        2,
    );
    lane.place_bet(basket_id, U256::from(100u32), second_quote)
        .with_actor_id(harness.alice)
        .await
        .expect("second bet should succeed");

    let merged_position = lane
        .get_position(harness.alice, basket_id)
        .await
        .expect("position query should succeed");

    assert_eq!(merged_position.shares, U256::from(200u32));
    assert_eq!(merged_position.index_at_creation_bps, 6_000);

    harness.mint(harness.bet_lane.id(), 133).await;
    harness.finalize_yes_settlement(basket_id).await;

    let payout = lane
        .claim(basket_id)
        .with_actor_id(harness.alice)
        .await
        .expect("claim should succeed");

    assert_eq!(payout, U256::from(333u32));
}

#[tokio::test(flavor = "current_thread")]
async fn claim_requires_finalized_settlement_and_settled_basket_blocks_new_bets() {
    let harness = Harness::new().await;
    let basket_id = harness.create_basket(BasketAssetKind::Bet).await;

    harness.mint(harness.alice, 50).await;
    harness.approve_lane(harness.alice, 50).await;

    let mut lane = harness.bet_lane.bet_lane();
    let first_quote = harness.signed_quote(
        harness.alice,
        basket_id,
        U256::from(50u32),
        8_000,
        VALID_QUOTE_DEADLINE_MS,
        1,
    );
    lane.place_bet(basket_id, U256::from(50u32), first_quote)
        .with_actor_id(harness.alice)
        .await
        .expect("place bet should succeed");

    let claim_before_settlement = lane.claim(basket_id).with_actor_id(harness.alice).await;
    assert!(claim_before_settlement.is_err());

    harness.finalize_yes_settlement(basket_id).await;

    harness.mint(harness.bob, 50).await;
    harness.approve_lane(harness.bob, 50).await;
    let late_quote = harness.signed_quote(
        harness.bob,
        basket_id,
        U256::from(50u32),
        7_000,
        VALID_QUOTE_DEADLINE_MS,
        1,
    );
    let late_bet = lane
        .place_bet(basket_id, U256::from(50u32), late_quote)
        .with_actor_id(harness.bob)
        .await;
    assert!(late_bet.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn max_bet_applies_to_total_user_exposure() {
    let harness = Harness::new_with_lane_config(Some(BetLaneConfig {
        min_bet: U256::from(10u32),
        max_bet: U256::from(100u32),
        payouts_allowed_while_paused: true,
        quote_signer: ActorId::zero(),
    }))
    .await;
    let basket_id = harness.create_basket(BasketAssetKind::Bet).await;

    harness.mint(harness.alice, 120).await;
    harness.approve_lane(harness.alice, 120).await;

    let mut lane = harness.bet_lane.bet_lane();
    let first_quote = harness.signed_quote(
        harness.alice,
        basket_id,
        U256::from(60u32),
        5_000,
        VALID_QUOTE_DEADLINE_MS,
        1,
    );
    lane.place_bet(basket_id, U256::from(60u32), first_quote)
        .with_actor_id(harness.alice)
        .await
        .expect("first bet should succeed");

    let second_quote = harness.signed_quote(
        harness.alice,
        basket_id,
        U256::from(60u32),
        5_000,
        VALID_QUOTE_DEADLINE_MS,
        2,
    );
    let second_bet = lane
        .place_bet(basket_id, U256::from(60u32), second_quote)
        .with_actor_id(harness.alice)
        .await;

    assert!(second_bet.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn vara_baskets_reject_bet_lane_positions() {
    let harness = Harness::new().await;
    let vara_enabled = harness
        .mirror
        .basket_market()
        .set_vara_enabled(true)
        .with_actor_id(harness.admin)
        .await
        .expect("admin should enable vara support");
    assert_eq!(vara_enabled, ());
    let basket_id = harness.create_basket(BasketAssetKind::Vara).await;

    harness.mint(harness.alice, 50).await;
    harness.approve_lane(harness.alice, 50).await;

    let mut lane = harness.bet_lane.bet_lane();
    let quote = harness.signed_quote(
        harness.alice,
        basket_id,
        U256::from(50u32),
        5_000,
        VALID_QUOTE_DEADLINE_MS,
        1,
    );
    let result = lane
        .place_bet(basket_id, U256::from(50u32), quote)
        .with_actor_id(harness.alice)
        .await;

    assert!(result.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn config_role_can_update_dependency_addresses() {
    let harness = Harness::new().await;
    let outsider = ActorId::from([9u8; 32]);

    let mut lane = harness.bet_lane.bet_lane();

    let unauthorized = lane
        .set_dependencies(BetLaneDependencies {
            basket_program_id: outsider,
            bet_token_id: harness.bet_token.id(),
        })
        .with_actor_id(harness.bob)
        .await;
    assert!(unauthorized.is_err());

    lane.set_dependencies(BetLaneDependencies {
        basket_program_id: outsider,
        bet_token_id: harness.bet_token.id(),
    })
    .with_actor_id(harness.admin)
    .await
    .expect("admin should update dependencies");

    let deps = lane
        .get_dependencies()
        .await
        .expect("dependencies query should succeed");
    assert_eq!(deps.basket_program_id, outsider);
    assert_eq!(deps.bet_token_id, harness.bet_token.id());

    let invalid = lane
        .set_dependencies(BetLaneDependencies {
            basket_program_id: ActorId::zero(),
            bet_token_id: harness.bet_token.id(),
        })
        .with_actor_id(harness.admin)
        .await;
    assert!(invalid.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn quote_nonce_cannot_be_replayed() {
    let harness = Harness::new().await;
    let basket_id = harness.create_basket(BasketAssetKind::Bet).await;

    harness.mint(harness.alice, 200).await;
    harness.approve_lane(harness.alice, 200).await;

    let signed_quote = harness.signed_quote(
        harness.alice,
        basket_id,
        U256::from(100u32),
        5_000,
        VALID_QUOTE_DEADLINE_MS,
        42,
    );

    let mut lane = harness.bet_lane.bet_lane();
    lane.place_bet(basket_id, U256::from(100u32), signed_quote.clone())
        .with_actor_id(harness.alice)
        .await
        .expect("first quote use should succeed");

    let replay = lane
        .place_bet(basket_id, U256::from(100u32), signed_quote)
        .with_actor_id(harness.alice)
        .await;
    assert!(replay.is_err());
}


#[tokio::test(flavor = "current_thread")]
async fn expired_quote_is_rejected() {
    let harness = Harness::new().await;
    let basket_id = harness.create_basket(BasketAssetKind::Bet).await;

    harness.mint(harness.alice, 100).await;
    harness.approve_lane(harness.alice, 100).await;

    let mut lane = harness.bet_lane.bet_lane();
    let expired_quote =
        harness.signed_quote(harness.alice, basket_id, U256::from(100u32), 5_000, 0, 1);
    let result = lane
        .place_bet(basket_id, U256::from(100u32), expired_quote)
        .with_actor_id(harness.alice)
        .await;

    assert!(result.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn quote_signer_rotation_invalidates_old_signer_quotes() {
    let harness = Harness::new().await;
    let basket_id = harness.create_basket(BasketAssetKind::Bet).await;

    harness.mint(harness.alice, 200).await;
    harness.approve_lane(harness.alice, 200).await;

    let mut lane = harness.bet_lane.bet_lane();
    let old_quote = harness.signed_quote(
        harness.alice,
        basket_id,
        U256::from(100u32),
        5_000,
        VALID_QUOTE_DEADLINE_MS,
        1,
    );

    let new_signer = keypair_from_seed([8u8; 32]);
    let new_signer_actor = ActorId::from(new_signer.public.to_bytes());
    lane.rotate_quote_signer(new_signer_actor)
        .with_actor_id(harness.admin)
        .await
        .expect("admin should rotate quote signer");

    let old_result = lane
        .place_bet(basket_id, U256::from(100u32), old_quote)
        .with_actor_id(harness.alice)
        .await;
    assert!(old_result.is_err());

    let payload = BetQuotePayload {
        target_program_id: harness.bet_lane.id(),
        user: harness.alice,
        basket_id,
        amount: U256::from(100u32),
        quoted_index_bps: 5_000,
        deadline_ms: VALID_QUOTE_DEADLINE_MS,
        nonce: 2,
    };
    let message = [
        b"<Bytes>".to_vec(),
        [b"BetLaneQuoteV1".encode(), payload.encode()].concat(),
        b"</Bytes>".to_vec(),
    ]
    .concat();
    let signature = new_signer
        .sign(signing_context(b"substrate").bytes(&message))
        .to_bytes()
        .to_vec();

    let new_quote = SignedBetQuote { payload, signature };
    lane.place_bet(basket_id, U256::from(100u32), new_quote)
        .with_actor_id(harness.alice)
        .await
        .expect("new signer quote should succeed");
}

#[tokio::test(flavor = "current_thread")]
async fn migration_imports_require_pause_and_restore_state() {
    let harness = Harness::new().await;
    let mut lane = harness.bet_lane.bet_lane();

    let live_import = lane
        .import_positions(vec![ImportedPosition {
            basket_id: 77,
            user: harness.alice,
            shares: U256::from(300u32),
            claimed: true,
            index_at_creation_bps: 6_500,
        }])
        .with_actor_id(harness.admin)
        .await;
    assert!(live_import.is_err());

    lane.pause()
        .with_actor_id(harness.admin)
        .await
        .expect("pause should succeed");

    let imported_positions = lane
        .import_positions(vec![ImportedPosition {
            basket_id: 77,
            user: harness.alice,
            shares: U256::from(300u32),
            claimed: true,
            index_at_creation_bps: 6_500,
        }])
        .with_actor_id(harness.admin)
        .await
        .expect("position import should succeed");
    let imported_nonces = lane
        .import_quote_nonces(vec![ImportedQuoteNonce {
            user: harness.alice,
            nonce: 999,
        }])
        .with_actor_id(harness.admin)
        .await
        .expect("nonce import should succeed");

    assert_eq!(imported_positions, 1);
    assert_eq!(imported_nonces, 1);

    let stored_position = lane
        .get_position(harness.alice, 77)
        .await
        .expect("position query should succeed");
    let position_count = lane
        .get_position_count()
        .await
        .expect("position count query should succeed");
    let nonce_count = lane
        .get_used_quote_nonce_count()
        .await
        .expect("nonce count query should succeed");
    let nonce_used = lane
        .is_quote_nonce_used(harness.alice, 999)
        .await
        .expect("nonce query should succeed");

    assert_eq!(stored_position.shares, U256::from(300u32));
    assert!(stored_position.claimed);
    assert_eq!(stored_position.index_at_creation_bps, 6_500);
    assert_eq!(position_count, 1);
    assert_eq!(nonce_count, 1);
    assert!(nonce_used);
}

fn keypair_from_seed(seed: [u8; 32]) -> Keypair {
    MiniSecretKey::from_bytes(&seed)
        .expect("seed should be valid")
        .expand_to_keypair(ExpansionMode::Ed25519)
}
