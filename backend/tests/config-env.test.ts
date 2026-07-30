import assert from "node:assert/strict";
import test from "node:test";

import { loadBackendConfig, loadMigrationConfig } from "../src/config/env.js";

test("configuration exposes signer identifiers without accepting raw keys", () => {
  const config = loadBackendConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://localhost/alphabasket",
    ACCOUNTING_SOLANA_RPC_URL: "http://localhost:8899",
    CAPITAL_SOLANA_RPC_URL: "http://localhost:8899",
    CAPITAL_SOLANA_USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    COMPOSER_SIGNER_KEY_ID: "composer-test",
    BACKEND_SIGNER_KEY_ID: "backend-test",
    POLYMARKET_SIGNER_KEY_ID: "polymarket-test",
    SOLANA_SETTLEMENT_SIGNER_KEY_ID: "settlement-test",
  });

  assert.equal(config.environment, "test");
  assert.deepEqual(config.api, {
    host: "127.0.0.1",
    port: 3_001,
    shutdownGraceMs: 10_000,
    allowedOrigins: [],
    maximumBodyBytes: 65_536,
    maximumNavAgeMs: 30_000n,
  });
  assert.equal(config.temporal.taskQueue, "alphabasket");
  assert.equal(config.solana.accounting.programId, "5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm");
  assert.equal(config.solana.capital.usdcMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(config.signers.composerKeyId, "composer-test");
  assert.equal(config.deployment.mode, "local");
  assert.equal(config.jupiter.enabled, false);
  assert.equal("privateKey" in config.signers, false);
});

test("configuration allows backend Jupiter execution with devnet accounting and mainnet capital", () => {
  const config = loadBackendConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://localhost/alphabasket",
    ACCOUNTING_SOLANA_RPC_URL: "https://api.devnet.solana.com",
    ACCOUNTING_SOLANA_CLUSTER: "devnet",
    CAPITAL_SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    CAPITAL_SOLANA_CLUSTER: "mainnet-beta",
    CAPITAL_SOLANA_USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    SOLANA_SETTLEMENT_RECEIVER: "SysvarRent111111111111111111111111111111111",
    DEPLOYMENT_MODE: "hybrid_devnet",
    CAPITAL_MODE: "live_bridge",
    JUPITER_SPOT_ENABLED: "true",
    JUPITER_API_KEY: "test-key",
    COMPOSER_SIGNER_KEY_ID: "composer-test",
    BACKEND_SIGNER_KEY_ID: "backend-test",
    POLYMARKET_SIGNER_KEY_ID: "polymarket-test",
    SOLANA_SETTLEMENT_SIGNER_KEY_ID: "settlement-test",
  });
  assert.equal(config.jupiter.enabled, true);
  assert.equal(config.deployment.accountingSolanaCluster, "devnet");
  assert.equal(config.deployment.capitalSolanaCluster, "mainnet-beta");
});

test("migration configuration requires only the database URL", () => {
  assert.deepEqual(
    loadMigrationConfig({ DATABASE_URL: "postgresql://localhost/alphabasket" }),
    { databaseUrl: "postgresql://localhost/alphabasket" },
  );
  assert.throws(() => loadMigrationConfig({}), /DATABASE_URL/u);
});

test("configuration allows devnet accounting with mainnet capital execution", () => {
  const config = loadBackendConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://localhost/alphabasket",
    ACCOUNTING_SOLANA_RPC_URL: "https://api.devnet.solana.com",
    ACCOUNTING_SOLANA_CLUSTER: "devnet",
    CAPITAL_SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    CAPITAL_SOLANA_CLUSTER: "mainnet-beta",
    CAPITAL_SOLANA_USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    DEPLOYMENT_MODE: "hybrid_devnet",
    CAPITAL_MODE: "live_bridge",
    COMPOSER_SIGNER_KEY_ID: "composer-test",
    BACKEND_SIGNER_KEY_ID: "backend-test",
    POLYMARKET_SIGNER_KEY_ID: "polymarket-test",
    SOLANA_SETTLEMENT_SIGNER_KEY_ID: "settlement-test",
  });
  assert.equal(config.deployment.accountingSolanaCluster, "devnet");
  assert.equal(config.deployment.capitalSolanaCluster, "mainnet-beta");
  assert.notEqual(config.solana.accounting.rpcUrl, config.solana.capital.rpcUrl);
});

test("configuration rejects live bridge capital on a non-mainnet capital RPC", () => {
  assert.throws(() => loadBackendConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://localhost/alphabasket",
    ACCOUNTING_SOLANA_RPC_URL: "https://api.devnet.solana.com",
    ACCOUNTING_SOLANA_CLUSTER: "devnet",
    CAPITAL_SOLANA_RPC_URL: "https://capital.devnet.example",
    CAPITAL_SOLANA_CLUSTER: "devnet",
    CAPITAL_SOLANA_USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    DEPLOYMENT_MODE: "hybrid_devnet",
    CAPITAL_MODE: "live_bridge",
    COMPOSER_SIGNER_KEY_ID: "composer-test",
    BACKEND_SIGNER_KEY_ID: "backend-test",
    POLYMARKET_SIGNER_KEY_ID: "polymarket-test",
    SOLANA_SETTLEMENT_SIGNER_KEY_ID: "settlement-test",
  }), /capital Solana mainnet-beta/u);
});

test("configuration requires live bridge capital for production modes", () => {
  assert.throws(() => loadBackendConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://localhost/alphabasket",
    ACCOUNTING_SOLANA_RPC_URL: "https://accounting.mainnet.example",
    ACCOUNTING_SOLANA_CLUSTER: "mainnet-beta",
    CAPITAL_SOLANA_RPC_URL: "https://capital.mainnet.example",
    CAPITAL_SOLANA_CLUSTER: "mainnet-beta",
    CAPITAL_SOLANA_USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    DEPLOYMENT_MODE: "production_canary",
    CAPITAL_MODE: "prefunded_staging",
    COMPOSER_SIGNER_KEY_ID: "composer-test",
    BACKEND_SIGNER_KEY_ID: "backend-test",
    POLYMARKET_SIGNER_KEY_ID: "polymarket-test",
    SOLANA_SETTLEMENT_SIGNER_KEY_ID: "settlement-test",
  }), /live_bridge/u);
});
