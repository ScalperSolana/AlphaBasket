use awesome_sails_access_control::DEFAULT_ADMIN_ROLE;
use awesome_sails_vft_admin::{BURNER_ROLE, MINTER_ROLE, PAUSER_ROLE};
use bet_token::WASM_BINARY;
use bet_token_client::{
    BetTokenClient, BetTokenClientCtors, ClaimState, ImportedBalance, ImportedClaimState,
    access_control::AccessControl, bet_token::BetToken, bet_token::events::BetTokenEvents,
    vft_admin::VftAdmin, vft_admin::events::VftAdminEvents,
};
use futures::StreamExt;
use gtest::System;
use gtest::constants::{
    BLOCK_DURATION_IN_MSECS, DEFAULT_USER_ALICE, DEFAULT_USER_BOB, DEFAULT_USER_CHARLIE,
    DEFAULT_USER_EVE,
};
use sails_rs::client::{GearEnv, GtestEnv};
use sails_rs::prelude::{ActorId, U256};

const TOKEN_NAME: &str = "Bet Token";
const TOKEN_SYMBOL: &str = "BET";
const TOKEN_DECIMALS: u8 = 12;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const HOUR_MS: u64 = 60 * 60 * 1000;
const HALF_DAY_MS: u64 = 12 * 60 * 60 * 1000;
const CHIP_UNIT: u128 = 1_000_000_000_000;

fn chip_units(amount: u128) -> U256 {
    U256::from(amount.saturating_mul(CHIP_UNIT))
}

struct Harness {
    env: GtestEnv,
    program: sails_rs::client::Actor<bet_token_client::BetTokenClientProgram, GtestEnv>,
    admin: ActorId,
    alice: ActorId,
    bob: ActorId,
    betting: ActorId,
}

impl Harness {
    async fn new() -> Self {
        let system = System::new();
        system.init_logger();

        let admin = ActorId::from(DEFAULT_USER_ALICE);
        let alice = ActorId::from(DEFAULT_USER_BOB);
        let bob = ActorId::from(DEFAULT_USER_CHARLIE);
        let betting = ActorId::from(DEFAULT_USER_EVE);

        let env = GtestEnv::new(system, admin);
        let code_id = env.system().submit_code(WASM_BINARY);
        let program = env
            .deploy(code_id, b"bet-token".to_vec())
            .create(
                admin,
                TOKEN_NAME.into(),
                TOKEN_SYMBOL.into(),
                TOKEN_DECIMALS,
                None,
            )
            .await
            .expect("bet-token deployment should succeed");

        Self {
            env,
            program,
            admin,
            alice,
            bob,
            betting,
        }
    }

    fn advance_blocks(&self, blocks: u64) {
        let next_block = self
            .env
            .system()
            .block_height()
            .saturating_add(blocks as u32);
        self.env.system().run_to_block(next_block);
    }

    fn advance_ms(&self, ms: u64) {
        let blocks = ms.div_ceil(BLOCK_DURATION_IN_MSECS);
        self.advance_blocks(blocks);
    }

    fn advance_claim_day(&self, days: u64) {
        self.advance_ms(DAY_MS.saturating_mul(days));
    }

    async fn set_claim_day_start_offset(&self, offset_ms: u64) {
        let mut service = self.program.bet_token();
        service
            .set_claim_day_start_offset(offset_ms)
            .with_actor_id(self.admin)
            .await
            .expect("admin should set claim day start offset");
    }

    async fn claim_as(&self, actor: ActorId) -> ClaimState {
        let mut service = self.program.bet_token();
        service
            .claim()
            .with_actor_id(actor)
            .await
            .expect("claim should succeed")
    }
}

#[tokio::test(flavor = "current_thread")]
async fn first_claim_mints_base_reward() {
    let harness = Harness::new().await;

    let state = harness.claim_as(harness.alice).await;

    assert_eq!(state.streak_days, 1);
    assert_eq!(state.claim_count, 1);
    assert_eq!(state.total_claimed, chip_units(500));

    let service = harness.program.bet_token();
    let balance = service
        .balance_of(harness.alice)
        .await
        .expect("balance query should succeed");

    assert_eq!(balance, chip_units(500));
}

#[tokio::test(flavor = "current_thread")]
async fn claim_is_rejected_before_hourly_window() {
    let harness = Harness::new().await;
    let _ = harness.claim_as(harness.alice).await;

    let mut service = harness.program.bet_token();
    let second_claim = service.claim().with_actor_id(harness.alice).await;
    assert!(second_claim.is_err());

    let state = service
        .get_claim_state(harness.alice)
        .await
        .expect("claim state query should succeed");
    let balance = service
        .balance_of(harness.alice)
        .await
        .expect("balance query should succeed");

    assert_eq!(state.streak_days, 1);
    assert_eq!(state.claim_count, 1);
    assert_eq!(balance, chip_units(500));
}

#[tokio::test(flavor = "current_thread")]
async fn hourly_claims_keep_same_daily_streak() {
    let harness = Harness::new().await;

    let mut last_state = harness.claim_as(harness.alice).await;
    for _ in 0..3 {
        harness.advance_ms(HOUR_MS);
        last_state = harness.claim_as(harness.alice).await;
    }

    assert_eq!(last_state.streak_days, 1);
    assert_eq!(last_state.claim_count, 4);

    let service = harness.program.bet_token();
    let balance = service
        .balance_of(harness.alice)
        .await
        .expect("balance query should succeed");

    assert_eq!(balance, chip_units(2000));
}

#[tokio::test(flavor = "current_thread")]
async fn streak_grows_by_day_and_caps_at_config_limit() {
    let harness = Harness::new().await;

    let mut last_state = harness.claim_as(harness.alice).await;
    for _ in 0..11 {
        harness.advance_claim_day(1);
        last_state = harness.claim_as(harness.alice).await;
    }

    assert_eq!(last_state.streak_days, 11);

    let service = harness.program.bet_token();
    let balance = service
        .balance_of(harness.alice)
        .await
        .expect("balance query should succeed");

    assert_eq!(balance, chip_units(6650));
}

#[tokio::test(flavor = "current_thread")]
async fn missed_window_resets_streak() {
    let harness = Harness::new().await;

    let _ = harness.claim_as(harness.alice).await;
    harness.advance_claim_day(1);
    let _ = harness.claim_as(harness.alice).await;

    harness.advance_claim_day(2);
    let state = harness.claim_as(harness.alice).await;

    assert_eq!(state.streak_days, 1);
    assert_eq!(state.claim_count, 3);
}

#[tokio::test(flavor = "current_thread")]
async fn streak_advances_on_next_utc_day_even_before_24h_passes() {
    let harness = Harness::new().await;
    harness.set_claim_day_start_offset(HALF_DAY_MS).await;
    harness.advance_ms(HALF_DAY_MS.saturating_sub(BLOCK_DURATION_IN_MSECS));

    let first_claim = harness.claim_as(harness.alice).await;
    let next_claim_at = first_claim
        .last_claim_at
        .map(|last_claim_at| {
            ((last_claim_at as i128 - HALF_DAY_MS as i128).div_euclid(DAY_MS as i128) + 1) as u64
        })
        .map(|next_day| next_day.saturating_mul(DAY_MS).saturating_add(HALF_DAY_MS))
        .expect("claim timestamp should exist");

    harness.advance_ms(next_claim_at.saturating_sub(first_claim.last_claim_at.unwrap_or_default()));
    let second_claim = harness.claim_as(harness.alice).await;

    assert_eq!(second_claim.streak_days, 2);
}

#[tokio::test(flavor = "current_thread")]
async fn claim_pause_and_resume_work_independently() {
    let harness = Harness::new().await;

    let mut service = harness.program.bet_token();
    service
        .pause_claim()
        .with_actor_id(harness.admin)
        .await
        .expect("admin should pause claim");

    let paused = service
        .is_claim_paused()
        .await
        .expect("claim pause state query should succeed");
    assert!(paused);

    let claim_while_paused = service.claim().with_actor_id(harness.alice).await;
    assert!(claim_while_paused.is_err());

    service
        .resume_claim()
        .with_actor_id(harness.admin)
        .await
        .expect("admin should resume claim");

    let resumed_state = harness.claim_as(harness.alice).await;
    assert_eq!(resumed_state.streak_days, 1);
}

#[tokio::test(flavor = "current_thread")]
async fn admin_can_update_claim_day_start_offset() {
    let harness = Harness::new().await;
    harness.set_claim_day_start_offset(HALF_DAY_MS).await;

    let service = harness.program.bet_token();
    let config = service
        .get_claim_config()
        .await
        .expect("claim config query should succeed");

    assert_eq!(config.day_start_offset_ms, HALF_DAY_MS);
}

#[tokio::test(flavor = "current_thread")]
async fn direct_transfer_is_forbidden_for_regular_holder() {
    let harness = Harness::new().await;
    let _ = harness.claim_as(harness.alice).await;

    let mut service = harness.program.bet_token();
    let result = service
        .transfer(harness.bob, U256::from(10u32))
        .with_actor_id(harness.alice)
        .await;

    assert!(result.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn admin_can_mint_and_transfer_directly() {
    let harness = Harness::new().await;

    let mut service = harness.program.bet_token();
    service
        .admin_mint(harness.admin, U256::from(500u32))
        .with_actor_id(harness.admin)
        .await
        .expect("admin should mint directly through service");

    service
        .transfer(harness.alice, U256::from(125u32))
        .with_actor_id(harness.admin)
        .await
        .expect("admin should transfer directly");

    let admin_balance = service
        .balance_of(harness.admin)
        .await
        .expect("admin balance query should succeed");
    let alice_balance = service
        .balance_of(harness.alice)
        .await
        .expect("alice balance query should succeed");

    assert_eq!(admin_balance, U256::from(375u32));
    assert_eq!(alice_balance, U256::from(125u32));
}

#[tokio::test(flavor = "current_thread")]
async fn non_admin_cannot_admin_mint() {
    let harness = Harness::new().await;

    let mut service = harness.program.bet_token();
    let mint_result = service
        .admin_mint(harness.alice, U256::from(1u32))
        .with_actor_id(harness.bob)
        .await;

    assert!(mint_result.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn transfer_from_requires_allowed_spender() {
    let harness = Harness::new().await;
    let _ = harness.claim_as(harness.alice).await;

    let mut service = harness.program.bet_token();
    service
        .approve(harness.betting, U256::from(50u32))
        .with_actor_id(harness.alice)
        .await
        .expect("approve should succeed");

    let result = service
        .transfer_from(harness.alice, harness.bob, U256::from(50u32))
        .with_actor_id(harness.betting)
        .await;

    assert!(result.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn allowed_spender_can_execute_transfer_from() {
    let harness = Harness::new().await;
    let _ = harness.claim_as(harness.alice).await;

    let mut service = harness.program.bet_token();
    service
        .allow_spender(harness.betting)
        .with_actor_id(harness.admin)
        .await
        .expect("admin should allow betting spender");

    service
        .approve(harness.betting, U256::from(70u32))
        .with_actor_id(harness.alice)
        .await
        .expect("approve should succeed");

    service
        .transfer_from(harness.alice, harness.bob, U256::from(70u32))
        .with_actor_id(harness.betting)
        .await
        .expect("allowed spender should transfer tokens");

    let alice_balance = service
        .balance_of(harness.alice)
        .await
        .expect("alice balance query should succeed");
    let bob_balance = service
        .balance_of(harness.bob)
        .await
        .expect("bob balance query should succeed");
    let allowance = service
        .allowance(harness.alice, harness.betting)
        .await
        .expect("allowance query should succeed");

    assert_eq!(alice_balance, chip_units(500) - U256::from(70u32));
    assert_eq!(bob_balance, U256::from(70u32));
    assert_eq!(allowance, U256::from(0u8));
}

#[tokio::test(flavor = "current_thread")]
async fn disallowed_spender_loses_transfer_from_access() {
    let harness = Harness::new().await;
    let _ = harness.claim_as(harness.alice).await;

    let mut service = harness.program.bet_token();
    service
        .allow_spender(harness.betting)
        .with_actor_id(harness.admin)
        .await
        .expect("admin should allow spender");
    service
        .disallow_spender(harness.betting)
        .with_actor_id(harness.admin)
        .await
        .expect("admin should disallow spender");
    service
        .approve(harness.betting, U256::from(25u32))
        .with_actor_id(harness.alice)
        .await
        .expect("approve should succeed");

    let result = service
        .transfer_from(harness.alice, harness.bob, U256::from(25u32))
        .with_actor_id(harness.betting)
        .await;

    assert!(result.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn add_admin_enables_follow_up_role_management() {
    let harness = Harness::new().await;

    let mut service = harness.program.bet_token();
    service
        .add_admin(harness.alice)
        .with_actor_id(harness.admin)
        .await
        .expect("root admin should add a second admin");

    service
        .grant_role(MINTER_ROLE, harness.bob)
        .with_actor_id(harness.alice)
        .await
        .expect("new admin should be able to grant roles");

    let access_control = harness.program.access_control();
    let has_role = access_control
        .has_role(MINTER_ROLE, harness.bob)
        .await
        .expect("role query should succeed");
    let has_admin = access_control
        .has_role(DEFAULT_ADMIN_ROLE, harness.alice)
        .await
        .expect("admin role query should succeed");

    assert!(has_role);
    assert!(has_admin);
}

#[tokio::test(flavor = "current_thread")]
async fn non_admin_cannot_manage_roles() {
    let harness = Harness::new().await;

    let mut service = harness.program.bet_token();
    let add_admin = service
        .add_admin(harness.alice)
        .with_actor_id(harness.bob)
        .await;
    assert!(add_admin.is_err());

    let grant_role = service
        .grant_role(MINTER_ROLE, harness.bob)
        .with_actor_id(harness.alice)
        .await;
    assert!(grant_role.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn claim_emits_claimed_and_streak_updated_events() {
    let harness = Harness::new().await;

    let mut service = harness.program.bet_token();
    let listener = service.listener();
    let mut events = listener
        .listen()
        .await
        .expect("bet token listener should start");

    let state = service
        .claim()
        .with_actor_id(harness.alice)
        .await
        .expect("claim should succeed");

    let (_, first_event) = events.next().await.expect("first claim event should exist");
    let (_, second_event) = events
        .next()
        .await
        .expect("second claim event should exist");

    assert_eq!(
        first_event,
        BetTokenEvents::Claimed {
            user: harness.alice,
            amount: chip_units(500),
            streak_days: 1,
            claimed_at: state
                .last_claim_at
                .expect("claim timestamp should be present"),
        }
    );
    assert_eq!(
        second_event,
        BetTokenEvents::StreakUpdated {
            user: harness.alice,
            streak_days: 1,
            reset: false,
        }
    );
}

#[tokio::test(flavor = "current_thread")]
async fn claim_and_spender_admin_actions_emit_events() {
    let harness = Harness::new().await;

    let mut service = harness.program.bet_token();
    let listener = service.listener();
    let mut events = listener
        .listen()
        .await
        .expect("bet token listener should start");

    service
        .pause_claim()
        .with_actor_id(harness.admin)
        .await
        .expect("admin should pause claim");
    let (_, paused_event) = events.next().await.expect("pause event should exist");
    assert_eq!(paused_event, BetTokenEvents::ClaimPaused);

    service
        .resume_claim()
        .with_actor_id(harness.admin)
        .await
        .expect("admin should resume claim");
    let (_, resumed_event) = events.next().await.expect("resume event should exist");
    assert_eq!(resumed_event, BetTokenEvents::ClaimResumed);

    service
        .allow_spender(harness.betting)
        .with_actor_id(harness.admin)
        .await
        .expect("admin should allow spender");
    let (_, allowed_event) = events
        .next()
        .await
        .expect("spender allowed event should exist");
    assert_eq!(
        allowed_event,
        BetTokenEvents::SpenderAllowed(harness.betting)
    );

    service
        .disallow_spender(harness.betting)
        .with_actor_id(harness.admin)
        .await
        .expect("admin should disallow spender");
    let (_, disallowed_event) = events
        .next()
        .await
        .expect("spender disallowed event should exist");
    assert_eq!(
        disallowed_event,
        BetTokenEvents::SpenderDisallowed(harness.betting)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn approve_emits_event_and_false_means_allowance_unchanged() {
    let harness = Harness::new().await;
    let _ = harness.claim_as(harness.alice).await;

    let mut service = harness.program.bet_token();
    let listener = service.listener();
    let mut events = listener
        .listen()
        .await
        .expect("bet token listener should start");

    let first_approve = service
        .approve(harness.betting, U256::from(40u32))
        .with_actor_id(harness.alice)
        .await
        .expect("first approve should succeed");
    assert!(first_approve);

    let (_, first_event) = events
        .next()
        .await
        .expect("first approve event should exist");
    assert_eq!(
        first_event,
        BetTokenEvents::Approved {
            owner: harness.alice,
            spender: harness.betting,
            value: U256::from(40u32),
            changed: true,
        }
    );

    let second_approve = service
        .approve(harness.betting, U256::from(40u32))
        .with_actor_id(harness.alice)
        .await
        .expect("second approve should also succeed");
    assert!(!second_approve);

    let (_, second_event) = events
        .next()
        .await
        .expect("second approve event should exist");
    assert_eq!(
        second_event,
        BetTokenEvents::Approved {
            owner: harness.alice,
            spender: harness.betting,
            value: U256::from(40u32),
            changed: false,
        }
    );

    let allowance = service
        .allowance(harness.alice, harness.betting)
        .await
        .expect("allowance query should succeed");
    assert_eq!(allowance, U256::from(40u32));
}

#[tokio::test(flavor = "current_thread")]
async fn paused_migration_import_restores_balances_and_claim_states() {
    let harness = Harness::new().await;

    let mut token = harness.program.bet_token();
    let mut admin = harness.program.vft_admin();

    admin
        .pause()
        .with_actor_id(harness.admin)
        .await
        .expect("admin should pause token");
    token
        .pause_claim()
        .with_actor_id(harness.admin)
        .await
        .expect("admin should pause claim flow");

    let imported_balances = token
        .import_balances(vec![
            ImportedBalance {
                user: harness.alice,
                balance: U256::from(123u32),
            },
            ImportedBalance {
                user: harness.bob,
                balance: U256::from(456u32),
            },
        ])
        .with_actor_id(harness.admin)
        .await
        .expect("balance import should succeed");
    let imported_states = token
        .import_claim_states(vec![ImportedClaimState {
            user: harness.alice,
            state: ClaimState {
                last_claim_at: Some(1_700_000_000_000),
                streak_days: 4,
                total_claimed: U256::from(1600u32),
                claim_count: 4,
            },
        }])
        .with_actor_id(harness.admin)
        .await
        .expect("claim state import should succeed");

    assert_eq!(imported_balances, 2);
    assert_eq!(imported_states, 1);

    let alice_balance = token
        .balance_of(harness.alice)
        .await
        .expect("alice balance query");
    let bob_balance = token
        .balance_of(harness.bob)
        .await
        .expect("bob balance query");
    let alice_claim_state = token
        .get_claim_state(harness.alice)
        .await
        .expect("claim state query");
    let claim_state_count = token
        .get_claim_state_count()
        .await
        .expect("claim state count query");

    assert_eq!(alice_balance, U256::from(123u32));
    assert_eq!(bob_balance, U256::from(456u32));
    assert_eq!(alice_claim_state.streak_days, 4);
    assert_eq!(alice_claim_state.claim_count, 4);
    assert_eq!(alice_claim_state.total_claimed, U256::from(1600u32));
    assert_eq!(claim_state_count, 1);
}

#[tokio::test(flavor = "current_thread")]
async fn vft_admin_mint_requires_role_and_emits_event() {
    let harness = Harness::new().await;

    let mut service = harness.program.bet_token();
    service
        .grant_role(MINTER_ROLE, harness.admin)
        .with_actor_id(harness.admin)
        .await
        .expect("admin should grant MINTER_ROLE");

    let mut vft_admin = harness.program.vft_admin();
    let listener = vft_admin.listener();
    let mut events = listener
        .listen()
        .await
        .expect("vft admin listener should start");

    vft_admin
        .mint(harness.alice, U256::from(250u32))
        .with_actor_id(harness.admin)
        .await
        .expect("minter should mint tokens");

    let (_, event) = events.next().await.expect("mint event should exist");
    assert_eq!(event, VftAdminEvents::MinterTookPlace);

    let balance = harness
        .program
        .bet_token()
        .balance_of(harness.alice)
        .await
        .expect("balance query should succeed");
    assert_eq!(balance, U256::from(250u32));

    let unauthorized_mint = vft_admin
        .mint(harness.bob, U256::from(1u32))
        .with_actor_id(harness.bob)
        .await;
    assert!(unauthorized_mint.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn vft_admin_burn_requires_role_and_emits_event() {
    let harness = Harness::new().await;
    let _ = harness.claim_as(harness.alice).await;

    let mut service = harness.program.bet_token();
    service
        .grant_role(BURNER_ROLE, harness.admin)
        .with_actor_id(harness.admin)
        .await
        .expect("admin should grant BURNER_ROLE");

    let mut vft_admin = harness.program.vft_admin();
    let listener = vft_admin.listener();
    let mut events = listener
        .listen()
        .await
        .expect("vft admin listener should start");

    vft_admin
        .burn(harness.alice, U256::from(40u32))
        .with_actor_id(harness.admin)
        .await
        .expect("burner should burn tokens");

    let (_, event) = events.next().await.expect("burn event should exist");
    assert_eq!(event, VftAdminEvents::BurnerTookPlace);

    let balance = harness
        .program
        .bet_token()
        .balance_of(harness.alice)
        .await
        .expect("balance query should succeed");
    assert_eq!(balance, chip_units(500) - U256::from(40u32));
}

#[tokio::test(flavor = "current_thread")]
async fn vft_admin_pause_and_resume_require_role_emit_events_and_flip_state() {
    let harness = Harness::new().await;

    let mut service = harness.program.bet_token();
    service
        .grant_role(PAUSER_ROLE, harness.admin)
        .with_actor_id(harness.admin)
        .await
        .expect("admin should grant PAUSER_ROLE");

    let mut vft_admin = harness.program.vft_admin();
    let listener = vft_admin.listener();
    let mut events = listener
        .listen()
        .await
        .expect("vft admin listener should start");

    vft_admin
        .pause()
        .with_actor_id(harness.admin)
        .await
        .expect("pauser should pause token");
    let (_, pause_event) = events.next().await.expect("pause event should exist");
    assert_eq!(pause_event, VftAdminEvents::Paused);

    let paused_transfer = harness
        .program
        .bet_token()
        .approve(harness.betting, U256::from(1u32))
        .with_actor_id(harness.alice)
        .await;
    assert!(paused_transfer.is_err());

    vft_admin
        .resume()
        .with_actor_id(harness.admin)
        .await
        .expect("pauser should resume token");
    let (_, resume_event) = events.next().await.expect("resume event should exist");
    assert_eq!(resume_event, VftAdminEvents::Resumed);
}
