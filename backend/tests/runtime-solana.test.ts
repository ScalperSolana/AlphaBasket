import assert from "node:assert/strict";
import test from "node:test";

import { PublicKey } from "@solana/web3.js";

import { normalizeDecodedSolanaValue } from "../src/runtime/solana-read-adapter.js";

test("Solana decoder normalization preserves large integers without floats", () => {
  const key = new PublicKey(Buffer.alloc(32, 7));
  const normalized = normalizeDecodedSolanaValue({
      amount: (1n << 64n) - 1n,
      authority: key,
      hash: Uint8Array.from([0xde, 0xad]),
      enumValue: { active: {} },
    });
  // Normalized records intentionally have null prototypes; compare their JSON
  // representation while retaining prototype-pollution resistance.
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalized)) as unknown,
    {
      amount: "18446744073709551615",
      authority: key.toBase58(),
      hash: "dead",
      enumValue: { active: {} },
    },
  );
});

test("Solana decoder normalization rejects unsafe numeric values", () => {
  assert.throws(
    () => normalizeDecodedSolanaValue(Number.MAX_SAFE_INTEGER + 1),
    /safe integer/,
  );
  assert.throws(() => normalizeDecodedSolanaValue(1.5), /safe integer/);
});
