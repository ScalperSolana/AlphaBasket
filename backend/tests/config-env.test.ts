import assert from "node:assert/strict";
import test from "node:test";

import { loadBackendConfig } from "../src/config/env.js";

test("configuration exposes signer identifiers without accepting raw keys", () => {
  const config = loadBackendConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://localhost/alphabasket",
    SOLANA_RPC_URL: "http://localhost:8899",
    COMPOSER_SIGNER_KEY_ID: "composer-test",
    BACKEND_SIGNER_KEY_ID: "backend-test",
    POLYMARKET_SIGNER_KEY_ID: "polymarket-test",
    SOLANA_SETTLEMENT_SIGNER_KEY_ID: "settlement-test",
  });

  assert.equal(config.environment, "test");
  assert.equal(config.solana.programId, "5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm");
  assert.equal(config.signers.composerKeyId, "composer-test");
  assert.equal("privateKey" in config.signers, false);
});
