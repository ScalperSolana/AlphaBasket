use daily_contest::WASM_BINARY;
use daily_contest_client::{
    DailyContestClient, DailyContestClientCtors, DailyContestConfig, WinnerInput,
    daily_contest::DailyContest, daily_contest::events::DailyContestEvents,
};
use futures::StreamExt;
use gtest::System;
use gtest::constants::{
    BLOCK_DURATION_IN_MSECS, DEFAULT_USER_ALICE, DEFAULT_USER_BOB, DEFAULT_USER_CHARLIE,
    DEFAULT_USER_EVE,
};
use sails_rs::client::{GearEnv, GtestEnv};
use sails_rs::prelude::ActorId;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const DAILY_PAYOUTS: [u128; 5] = [50_000, 25_000, 15_000, 10_000, 8_000];

struct Harness {
    env: GtestEnv,
    program: sails_rs::client::Actor<daily_contest_client::DailyContestClientProgram, GtestEnv>,
    admin: ActorId,
    settler: ActorId,
    alice: ActorId,
    bob: ActorId,
    charlie: ActorId,
}

impl Harness {
    async fn new() -> Self {
        let system = System::new();
        system.init_logger();

        let admin = ActorId::from(DEFAULT_USER_ALICE);
        let settler = ActorId::from(DEFAULT_USER_BOB);
        let alice = ActorId::from(DEFAULT_USER_CHARLIE);
        let bob = ActorId::from(DEFAULT_USER_EVE);
        let charlie = ActorId::from([42u8; 32]);

        let env = GtestEnv::new(system, admin);
        let code_id = env.system().submit_code(WASM_BINARY);
        let program = env
            .deploy(code_id, b"daily-contest".to_vec())
            .new(DailyContestConfig {
                admin_role: admin,
                settler_role: settler,
                prize_payouts: DAILY_PAYOUTS.to_vec(),
                grace_period_ms: 0,
                day_boundary_offset_ms: 0,
            })
            .await
            .expect("daily-contest deployment should succeed");

        Self {
            env,
            program,
            admin,
            settler,
            alice,
            bob,
            charlie,
        }
    }

    fn advance_ms(&self, ms: u64) {
        let blocks = ms.div_ceil(BLOCK_DURATION_IN_MSECS);
        let next_block = self
            .env
            .system()
            .block_height()
            .saturating_add(blocks as u32);
        self.env.system().run_to_block(next_block);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn settle_day_pays_configured_top_five_and_emits_batch_event() {
    let harness = Harness::new().await;
    let mut service = harness.program.daily_contest();
    let listener = service.listener();
    let mut events = listener
        .listen()
        .await
        .expect("daily contest listener should start");

    service
        .fund()
        .with_actor_id(harness.admin)
        .with_value(DAILY_PAYOUTS.iter().sum())
        .await
        .expect("funding should succeed");

    let (_, funded_event) = events.next().await.expect("funded event should exist");
    assert!(matches!(funded_event, DailyContestEvents::Funded { .. }));

    harness.advance_ms(DAY_MS);

    let winners = vec![
        WinnerInput {
            account: harness.alice,
            realized_profit: 500,
        },
        WinnerInput {
            account: harness.bob,
            realized_profit: 400,
        },
        WinnerInput {
            account: harness.charlie,
            realized_profit: 300,
        },
        WinnerInput {
            account: ActorId::from([43u8; 32]),
            realized_profit: 200,
        },
        WinnerInput {
            account: ActorId::from([44u8; 32]),
            realized_profit: 100,
        },
    ];

    service
        .settle_day(0, winners.clone(), [1u8; 32], [2u8; 32])
        .with_actor_id(harness.settler)
        .await
        .expect("settlement should succeed");

    let (_, paid_event) = events
        .next()
        .await
        .expect("winners paid event should exist");
    let DailyContestEvents::WinnersPaid { day_id, payouts } = paid_event else {
        panic!("expected WinnersPaid event");
    };
    assert_eq!(day_id, 0);
    assert_eq!(payouts.len(), DAILY_PAYOUTS.len());
    for (index, payout) in payouts.iter().enumerate() {
        assert_eq!(payout.account, winners[index].account);
        assert_eq!(payout.realized_profit, winners[index].realized_profit);
        assert_eq!(payout.reward, DAILY_PAYOUTS[index]);
    }

    let (_, settled_event) = events.next().await.expect("day settled event should exist");
    assert!(matches!(
        settled_event,
        DailyContestEvents::DaySettled {
            day_id: 0,
            winner_count: 5,
            total_reward: 108_000,
            ..
        }
    ));

    let day = service
        .get_day(0)
        .await
        .expect("day query should succeed")
        .expect("day should be settled");
    assert_eq!(day.total_reward, 108_000);
    assert_eq!(day.winners, payouts);
}

#[tokio::test(flavor = "current_thread")]
async fn settlement_rejects_more_winners_than_configured_payouts() {
    let harness = Harness::new().await;
    let mut service = harness.program.daily_contest();

    service
        .fund()
        .with_actor_id(harness.admin)
        .with_value(DAILY_PAYOUTS.iter().sum())
        .await
        .expect("funding should succeed");
    harness.advance_ms(DAY_MS);

    let winners = (0u8..6)
        .map(|index| WinnerInput {
            account: ActorId::from([index.saturating_add(10); 32]),
            realized_profit: i128::from(100 - index),
        })
        .collect();

    let result = service
        .settle_day(0, winners, [1u8; 32], [2u8; 32])
        .with_actor_id(harness.settler)
        .await;

    assert!(result.is_err());
}
