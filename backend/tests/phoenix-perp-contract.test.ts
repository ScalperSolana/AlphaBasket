import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PublicKey } from "@solana/web3.js";

import {
  ALPHABASKET_PROGRAM_ID,
  canonicalCompositionBytes,
  canonicalPerpEligibilityBytes,
  compositionHash,
  derivePerpEventPda,
  derivePerpEligibilityListPda,
  derivePerpReceiptPda,
  derivePerpTraderRegistryPda,
  perpEligibilityHash,
  registryAccountsForComposition,
  sha256,
  type BasketAsset,
} from "../src/contract/index.js";

const bytes = (value: number): Buffer => Buffer.alloc(32, value);

const perp = (
  marketId: string,
  phoenixSubaccount: number,
  weightBps: number,
  overrides: Partial<{
    direction: "long" | "short";
    leverageBps: number;
    entryMarkPrice: bigint;
    marginPosted: bigint;
  }> = {},
): BasketAsset => ({
  marketId,
  kind: {
    perp: {
      direction: overrides.direction ?? "long",
      leverageBps: overrides.leverageBps ?? 30_000,
      entryMarkPrice: overrides.entryMarkPrice ?? 95_670_000n,
      marginPosted: overrides.marginPosted ?? 100_000_000n,
      phoenixSubaccount,
    },
  },
  weightBps,
});

/**
 * A perp-only basket caps any single item at `MAX_SINGLE_SOURCE_WEIGHT_BPS`
 * (3000) and requires the weights to total 10000, so every valid composition has
 * at least four items. `withFirst` varies only the first one.
 */
const perpItems: readonly BasketAsset[] = [
  perp("SOL", 1, 2_500),
  perp("BTC", 2, 2_500),
  perp("ETH", 3, 2_500),
  perp("HYPE", 4, 2_500),
];

const withFirst = (first: BasketAsset): readonly BasketAsset[] => [
  first,
  ...perpItems.slice(1),
];

describe("perpetual composition encoding", () => {
  it("encodes a perp item with variant tag 2 and the approved terms only", () => {
    const encoded = canonicalCompositionBytes(withFirst(perp("SOL", 7, 2_500)));
    // Count, then the first item: u16 marketId length, "SOL", tag 2, direction,
    // u16 leverage, subaccount, u16 weight.
    const firstItem = Buffer.concat([
      Buffer.from([3, 0]),
      Buffer.from("SOL", "utf8"),
      Buffer.from([2, 0]),
      Buffer.from([0x30, 0x75]), // 30000 LE
      Buffer.from([7]),
      Buffer.from([0xc4, 0x09]), // 2500 LE
    ]);
    assert.equal(encoded.readUInt16LE(0), 4);
    assert.deepEqual(encoded.subarray(2, 2 + firstItem.length), firstItem);
  });

  it("excludes the fields settlement rewrites from the hash", () => {
    // `complete_phoenix_trade` writes `marginPosted` and `entryMarkPrice` in
    // place. If either were hashed, the basket's composition hash would stop
    // matching its composition after the very first fill.
    const before = compositionHash(
      withFirst(perp("SOL", 1, 2_500, { marginPosted: 1n, entryMarkPrice: 2n })),
    );
    const after = compositionHash(
      withFirst(
        perp("SOL", 1, 2_500, { marginPosted: 999_999n, entryMarkPrice: 888n }),
      ),
    );
    assert.deepEqual(before, after);
  });

  it("includes every term the Composer approved", () => {
    const base = compositionHash(perpItems);
    assert.notDeepEqual(
      base,
      compositionHash(withFirst(perp("SOL", 9, 2_500))),
      "subaccount must be covered",
    );
    assert.notDeepEqual(
      base,
      compositionHash(withFirst(perp("SOL", 1, 2_500, { leverageBps: 20_000 }))),
      "leverage must be covered",
    );
    assert.notDeepEqual(
      base,
      compositionHash(withFirst(perp("SOL", 1, 2_500, { direction: "short" }))),
      "direction must be covered",
    );
    assert.notDeepEqual(
      base,
      compositionHash(withFirst(perp("DOGE", 1, 2_500))),
      "market must be covered",
    );
  });

  it("accepts a four-item perpetual basket", () => {
    const encoded = canonicalCompositionBytes(perpItems);
    assert.equal(encoded.readUInt16LE(0), 4);
  });

  it("refuses to mix perpetuals with prediction markets", () => {
    assert.throws(
      () =>
        canonicalCompositionBytes([
          perp("SOL", 1, 5_000),
          {
            marketId: "market-a",
            kind: { predictionMarket: { outcome: 1, ctfTokenId: bytes(1) } },
            weightBps: 5_000,
          },
        ]),
      /may not contain spot or prediction-market items/,
    );
  });

  it("refuses to mix perpetuals with spot", () => {
    assert.throws(
      () =>
        canonicalCompositionBytes([
          perp("SOL", 1, 5_000),
          {
            marketId: "SOL-spot",
            kind: { spot: { tokenMint: new PublicKey(bytes(9)) } },
            weightBps: 5_000,
          },
        ]),
      /may not contain spot or prediction-market items/,
    );
  });

  it("refuses Phoenix subaccount zero", () => {
    assert.throws(
      () => canonicalCompositionBytes(withFirst(perp("SOL", 0, 2_500))),
      /cross-margin account/,
    );
  });

  it("refuses leverage outside the supported bounds", () => {
    assert.throws(
      () =>
        canonicalCompositionBytes(
          withFirst(perp("SOL", 1, 2_500, { leverageBps: 9_999 })),
        ),
      /leverageBps must be in/,
    );
    assert.throws(
      () =>
        canonicalCompositionBytes(
          withFirst(perp("SOL", 1, 2_500, { leverageBps: 50_001 })),
        ),
      /leverageBps must be in/,
    );
  });

  it("refuses two items sharing one isolated subaccount", () => {
    assert.throws(
      () =>
        canonicalCompositionBytes([
          perp("SOL", 1, 2_500),
          perp("BTC", 1, 2_500),
          perp("ETH", 3, 2_500),
          perp("HYPE", 4, 2_500),
        ]),
      /duplicate perp market or isolated subaccount/,
    );
  });

  it("still requires weights to total 10000", () => {
    assert.throws(
      () => canonicalCompositionBytes([perp("SOL", 1, 2_500)]),
      /weights must total/,
    );
  });
});

describe("perp eligibility list encoding", () => {
  it("encodes market ids with a length prefix and nothing else", () => {
    // No `outcome`, no `ctfTokenId`: those are Polymarket/CTF fields and mean
    // nothing for a perpetual.
    assert.deepEqual(
      canonicalPerpEligibilityBytes([{ marketId: "SOL" }, { marketId: "BTC" }]),
      Buffer.concat([
        Buffer.from([2, 0]),
        Buffer.from([3, 0]),
        Buffer.from("SOL", "utf8"),
        Buffer.from([3, 0]),
        Buffer.from("BTC", "utf8"),
      ]),
    );
  });

  it("hashes the canonical bytes", () => {
    const markets = [{ marketId: "SOL" }];
    assert.deepEqual(
      perpEligibilityHash(markets),
      sha256(canonicalPerpEligibilityBytes(markets)),
    );
  });

  it("refuses duplicates and an empty list", () => {
    assert.throws(
      () => canonicalPerpEligibilityBytes([{ marketId: "SOL" }, { marketId: "SOL" }]),
      /duplicate market/,
    );
    assert.throws(() => canonicalPerpEligibilityBytes([]), /must contain 1-/);
  });
});

describe("perpetual PDAs", () => {
  it("derives every perp PDA under the program id", () => {
    const [list] = derivePerpEligibilityListPda(bytes(0xaa), 7n);
    const [registry] = derivePerpTraderRegistryPda(new PublicKey(bytes(0xbb)));
    const [receipt] = derivePerpReceiptPda(bytes(0xcc));
    const [event] = derivePerpEventPda(bytes(0xdd));

    for (const address of [list, registry, receipt, event]) {
      assert.ok(address instanceof PublicKey);
      assert.ok(!PublicKey.isOnCurve(address.toBytes()), "PDAs are off-curve");
    }

    // Every seed prefix is distinct, so no two perp account kinds collide.
    const all = new Set([
      list.toBase58(),
      registry.toBase58(),
      receipt.toBase58(),
      event.toBase58(),
    ]);
    assert.equal(all.size, 4);
  });

  it("does not collide with the accounting receipt namespace", () => {
    // The accounting `SettlementReceipt` lives at [b"receipt", hash]; a perp
    // receipt at [b"perp_receipt", hash] must be a different address even for
    // the same hash.
    const hash = bytes(0x55);
    const [perpReceipt] = derivePerpReceiptPda(hash);
    const [accountingReceipt] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt", "ascii"), hash],
      ALPHABASKET_PROGRAM_ID,
    );
    assert.notEqual(perpReceipt.toBase58(), accountingReceipt.toBase58());
  });

  it("is deterministic for the same inputs", () => {
    const [first] = derivePerpEligibilityListPda(bytes(0xaa), 7n);
    const [second] = derivePerpEligibilityListPda(bytes(0xaa), 7n);
    assert.equal(first.toBase58(), second.toBase58());

    // A different nonce is a different list.
    const [third] = derivePerpEligibilityListPda(bytes(0xaa), 8n);
    assert.notEqual(first.toBase58(), third.toBase58());
  });
});

describe("registry accounts for validate_basket_items", () => {
  const perpItem = { kind: { perp: {} } };
  const spotItem = { kind: { spot: {} } };
  const predictionItem = { kind: { predictionMarket: {} } };
  const perpEligibility = { listHash: bytes(0xaa), nonce: 7n };

  it("passes nothing for a prediction-only basket", () => {
    assert.deepEqual(registryAccountsForComposition([predictionItem]), []);
  });

  it("passes the token allowlist for a spot basket", () => {
    const accounts = registryAccountsForComposition([spotItem]);
    assert.equal(accounts.length, 1);
  });

  it("passes the perp eligibility list for a perpetual basket", () => {
    const accounts = registryAccountsForComposition([perpItem], {
      perpEligibility,
    });
    assert.equal(accounts.length, 1);
    const [expected] = derivePerpEligibilityListPda(
      perpEligibility.listHash,
      perpEligibility.nonce,
    );
    assert.equal(accounts[0]!.pubkey.toBase58(), expected.toBase58());
    assert.equal(accounts[0]!.isSigner, false);
    assert.equal(accounts[0]!.isWritable, false);
  });

  it("orders the token allowlist before the perp list", () => {
    // The program reads the allowlist with `.first()` and the perp list with
    // `.last()`, so the order is load-bearing rather than cosmetic.
    const accounts = registryAccountsForComposition([perpItem, spotItem], {
      perpEligibility,
    });
    assert.equal(accounts.length, 2);
    const [allowlist] = derivePerpEligibilityListPda(
      perpEligibility.listHash,
      perpEligibility.nonce,
    );
    assert.equal(accounts[1]!.pubkey.toBase58(), allowlist.toBase58());
  });

  it("refuses to build a perpetual composition with no eligibility list", () => {
    // Without this the transaction would be assembled and rejected on chain,
    // costing a fee to learn something knowable locally.
    assert.throws(
      () => registryAccountsForComposition([perpItem]),
      /no perp eligibility list was supplied/,
    );
  });
});
