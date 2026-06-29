use futures::executor::block_on;
use gtest::System;
use polymarket_mirror::WASM_BINARY;
use polymarket_mirror_client::{
    AgentInfo, Basket, BasketAssetKind, BasketItem, BasketMarketInit, BasketStatus, ItemResolution,
    Outcome, PolymarketMirror, PolymarketMirrorCtors, PolymarketMirrorProgram, Settlement,
    SettlementStatus, basket_market::BasketMarket,
};
use sails_rs::{
    client::{GtestEnv, Program as _},
    prelude::*,
};

const ADMIN: u64 = 1;
const SETTLER: u64 = 2;
const USER: u64 = 10;
const TEST_BALANCE: u128 = 200_000_000_000_000;
const QUOTE_SIGNER: u64 = 99;
const FUTURE_END: u64 = 1_900_000_000_000;

struct Harness {
    program: sails_rs::client::Actor<PolymarketMirrorProgram, GtestEnv>,
}

impl Harness {
    fn new() -> Self {
        let system = System::new();
        system.mint_to(ADMIN, TEST_BALANCE);
        system.mint_to(SETTLER, TEST_BALANCE);
        system.mint_to(USER, TEST_BALANCE);
        let code_id = system.submit_code(WASM_BINARY);
        let env = GtestEnv::new(system, ADMIN.into());

        let program = block_on(
            PolymarketMirrorProgram::deploy(code_id, b"migration-tests".to_vec())
                .with_env(&env)
                .new(BasketMarketInit {
                    admin_role: ADMIN.into(),
                    settler_role: SETTLER.into(),
                    liveness_ms: 60_000,
                    quote_signer: QUOTE_SIGNER.into(),
                    bet_cutoff_ms: 60_000,
                }),
        )
        .expect("program deploy");

        Self { program }
    }
}

#[test]
fn paused_mode_gates_live_writes_and_allows_batch_imports() {
    let h = Harness::new();
    let mut market = h.program.basket_market();

    block_on(market.pause().with_actor_id(ADMIN.into())).expect("pause should succeed");
    assert!(block_on(market.is_paused()).expect("pause query"));

    let live_create = block_on(
        market
            .create_basket(
                "live".into(),
                "should fail".into(),
                vec![BasketItem {
                    poly_market_id: "market-0".into(),
                    poly_slug: "market-0".into(),
                    weight_bps: 10_000,
                    selected_outcome: Outcome::YES,
                    end_timestamp: FUTURE_END,
                }],
                BasketAssetKind::Bet,
            )
            .with_actor_id(USER.into()),
    );
    assert!(live_create.is_err());

    let basket = Basket {
        id: 42,
        creator: USER.into(),
        name: "Imported Basket".into(),
        description: "Imported through migration".into(),
        items: vec![BasketItem {
            poly_market_id: "market-42".into(),
            poly_slug: "market-42".into(),
            weight_bps: 10_000,
            selected_outcome: Outcome::YES,
            end_timestamp: FUTURE_END,
        }],
        created_at: 1_700_000_000_000,
        status: BasketStatus::Settled,
        asset_kind: BasketAssetKind::Bet,
    };
    let settlement = Settlement {
        basket_id: 42,
        proposer: SETTLER.into(),
        item_resolutions: vec![ItemResolution {
            item_index: 0,
            resolved: Outcome::YES,
            poly_slug: "market-42".into(),
            poly_condition_id: None,
            poly_price_yes: 10_000,
            poly_price_no: 0,
        }],
        payout_per_share: 10_000,
        payload: "{\"source\":\"migration\"}".into(),
        proposed_at: 1_700_000_000_100,
        challenge_deadline: 1_700_000_060_000,
        finalized_at: Some(1_700_000_120_000),
        status: SettlementStatus::Finalized,
    };
    let position = polymarket_mirror_client::Position {
        basket_id: 42,
        user: USER.into(),
        shares: 1234,
        claimed: true,
        index_at_creation_bps: 5000,
    };
    let agent = AgentInfo {
        address: USER.into(),
        name: "imported-agent".into(),
        registered_at: 1_700_000_000_000,
        name_updated_at: 1_700_000_000_000,
    };

    let imported_baskets = block_on(
        market
            .import_baskets(vec![basket.clone()])
            .with_actor_id(ADMIN.into()),
    )
    .expect("basket import should succeed");
    let imported_settlements = block_on(
        market
            .import_settlements(vec![settlement.clone()])
            .with_actor_id(ADMIN.into()),
    )
    .expect("settlement import should succeed");
    let imported_positions = block_on(
        market
            .import_positions(vec![position.clone()])
            .with_actor_id(ADMIN.into()),
    )
    .expect("position import should succeed");
    let imported_agents = block_on(
        market
            .import_agents(vec![agent.clone()])
            .with_actor_id(ADMIN.into()),
    )
    .expect("agent import should succeed");

    assert_eq!(imported_baskets, 1);
    assert_eq!(imported_settlements, 1);
    assert_eq!(imported_positions, 1);
    assert_eq!(imported_agents, 1);

    let stored_basket = block_on(market.get_basket(42))
        .expect("basket query transport")
        .expect("basket result");
    let stored_settlement = block_on(market.get_settlement(42))
        .expect("settlement query transport")
        .expect("settlement result");
    let stored_positions = block_on(market.get_positions(USER.into())).expect("positions query");
    let stored_agent = block_on(market.get_agent(USER.into())).expect("agent query");

    assert_eq!(stored_basket, basket);
    assert_eq!(stored_settlement, settlement);
    assert_eq!(stored_positions, vec![position]);
    assert_eq!(stored_agent, Some(agent));
}
