import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SOLANA_PUBLIC_GENESIS_HASHES,
  assertSolanaRpcCluster,
} from "../src/runtime/index.js";

describe("Solana RPC responsibility guard", () => {
  it("accepts the exact configured public cluster genesis hash", async () => {
    const accounting = await assertSolanaRpcCluster(
      {
        getGenesisHash: async () => SOLANA_PUBLIC_GENESIS_HASHES.devnet,
      },
      "devnet",
      "accounting",
    );
    const capital = await assertSolanaRpcCluster(
      {
        getGenesisHash: async () => SOLANA_PUBLIC_GENESIS_HASHES["mainnet-beta"],
      },
      "mainnet-beta",
      "capital",
    );
    assert.equal(accounting, SOLANA_PUBLIC_GENESIS_HASHES.devnet);
    assert.equal(capital, SOLANA_PUBLIC_GENESIS_HASHES["mainnet-beta"]);
  });

  it("fails closed when devnet and mainnet RPC responsibilities are swapped", async () => {
    await assert.rejects(
      assertSolanaRpcCluster(
        {
          getGenesisHash: async () => SOLANA_PUBLIC_GENESIS_HASHES["mainnet-beta"],
        },
        "devnet",
        "accounting",
      ),
      /accounting.*does not match devnet/u,
    );
    await assert.rejects(
      assertSolanaRpcCluster(
        {
          getGenesisHash: async () => SOLANA_PUBLIC_GENESIS_HASHES.devnet,
        },
        "mainnet-beta",
        "capital",
      ),
      /capital.*does not match mainnet-beta/u,
    );
  });

  it("does not pin the unique genesis hash of a local validator", async () => {
    let requested = false;
    const result = await assertSolanaRpcCluster(
      {
        getGenesisHash: async () => {
          requested = true;
          return "local-genesis";
        },
      },
      "localnet",
      "accounting",
    );
    assert.equal(result, null);
    assert.equal(requested, false);
  });
});
