use futures::executor::block_on;
use gtest::System;
use polymarket_mirror::WASM_BINARY;
use polymarket_mirror_client::{
    BasketMarketInit, PolymarketMirror, PolymarketMirrorCtors, PolymarketMirrorProgram,
    basket_market::BasketMarket,
};
use sails_rs::{
    client::{GtestEnv, Program as _},
    prelude::*,
};

const ADMIN: u64 = 1;
const SETTLER: u64 = 2;
const AGENT_A: u64 = 10;
const AGENT_B: u64 = 11;
const TEST_BALANCE: u128 = 200_000_000_000_000;
const QUOTE_SIGNER: u64 = 99;

struct Harness {
    program: sails_rs::client::Actor<PolymarketMirrorProgram, GtestEnv>,
    env: GtestEnv,
}

impl Harness {
    fn new() -> Self {
        let system = System::new();
        system.mint_to(ADMIN, TEST_BALANCE);
        system.mint_to(SETTLER, TEST_BALANCE);
        system.mint_to(AGENT_A, TEST_BALANCE);
        system.mint_to(AGENT_B, TEST_BALANCE);
        let code_id = system.submit_code(WASM_BINARY);
        let env = GtestEnv::new(system, ADMIN.into());

        let program = block_on(
            PolymarketMirrorProgram::deploy(code_id, b"agent-tests".to_vec())
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

        Self { program, env }
    }

    fn register(&self, actor: u64, name: &str) {
        block_on(
            self.program
                .basket_market()
                .register_agent(name.into())
                .with_actor_id(actor.into()),
        )
        .expect("register agent");
    }

    fn register_fails(&self, actor: u64, name: &str) {
        let result = block_on(
            self.program
                .basket_market()
                .register_agent(name.into())
                .with_actor_id(actor.into()),
        );
        assert!(
            result.is_err(),
            "expected register to fail for name '{}'",
            name
        );
    }

    fn agent_count(&self) -> u64 {
        self.program
            .basket_market()
            .get_agent_count()
            .query()
            .expect("agent count")
    }

    fn advance_blocks(&self, blocks: u32) {
        let next = self.env.system().block_height().saturating_add(blocks);
        self.env.system().run_to_block(next);
    }
}

#[test]
fn register_agent_happy_path() {
    let h = Harness::new();
    assert_eq!(h.agent_count(), 0);

    h.register(AGENT_A, "hermes-alpha");
    assert_eq!(h.agent_count(), 1);

    let agents = h
        .program
        .basket_market()
        .get_all_agents()
        .query()
        .expect("get all");
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].name, "hermes-alpha");
    assert_eq!(agents[0].address, ActorId::from(AGENT_A));
}

#[test]
fn register_agent_name_too_short() {
    let h = Harness::new();
    h.register_fails(AGENT_A, "ab");
}

#[test]
fn register_agent_name_too_long() {
    let h = Harness::new();
    h.register_fails(AGENT_A, "abcdefghijklmnopqrstu"); // 21 chars
}

#[test]
fn register_agent_name_invalid_chars() {
    let h = Harness::new();
    h.register_fails(AGENT_A, "hello world");
    h.register_fails(AGENT_A, "-leading");
    h.register_fails(AGENT_A, "trailing-");
    // Note: "UPPER" is normalized to "upper" by the contract, so it passes validation.
    // Uppercase is accepted and lowercased, not rejected.
}

#[test]
fn register_agent_duplicate_name_rejected() {
    let h = Harness::new();
    h.register(AGENT_A, "taken-name");
    h.register_fails(AGENT_B, "taken-name");
}

#[test]
fn register_agent_same_name_noop() {
    let h = Harness::new();
    h.register(AGENT_A, "my-agent");

    // Same name again should succeed (no-op)
    block_on(
        h.program
            .basket_market()
            .register_agent("my-agent".into())
            .with_actor_id(AGENT_A.into()),
    )
    .expect("same name should be no-op");

    assert_eq!(h.agent_count(), 1);
}

#[test]
fn register_agent_uppercase_normalized() {
    let h = Harness::new();

    // Uppercase input should be rejected since validation requires lowercase
    // But our contract normalizes to lowercase first, so this should succeed
    block_on(
        h.program
            .basket_market()
            .register_agent("Hermes-Alpha".into())
            .with_actor_id(AGENT_A.into()),
    )
    .expect("uppercase should normalize to lowercase");

    let agents = h
        .program
        .basket_market()
        .get_all_agents()
        .query()
        .expect("get all");
    assert_eq!(agents[0].name, "hermes-alpha");
}

#[test]
fn rename_before_cooldown_rejected() {
    let h = Harness::new();
    h.register(AGENT_A, "first-name");

    h.advance_blocks(100); // not enough for 7 days

    h.register_fails(AGENT_A, "second-name");
}

#[test]
fn rename_after_cooldown() {
    let h = Harness::new();
    h.register(AGENT_A, "old-name");

    // 7 days = 7*24*60*60/3 = 201600 blocks
    h.advance_blocks(201_601);

    h.register(AGENT_A, "new-name");

    let agent = h
        .program
        .basket_market()
        .get_agent(AGENT_A.into())
        .query()
        .expect("get agent");
    assert!(agent.is_some());
    assert_eq!(agent.unwrap().name, "new-name");
}

#[test]
fn get_agent_not_found() {
    let h = Harness::new();
    let agent = h
        .program
        .basket_market()
        .get_agent(AGENT_A.into())
        .query()
        .expect("query");
    assert!(agent.is_none());
}

#[test]
fn existing_basket_flow_unaffected() {
    let h = Harness::new();
    h.register(AGENT_A, "test-agent");

    let count = h
        .program
        .basket_market()
        .get_basket_count()
        .query()
        .expect("basket count");
    assert_eq!(count, 0);
}
