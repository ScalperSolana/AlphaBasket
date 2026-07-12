import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MANAGEMENT_FEE_PERIOD_SECS,
  accrueManagementFee,
} from "../src/accounting/index.js";
import {
  NAV_SHARE_PRICE_SCALE,
  NavSnapshotService,
  type NavSnapshot,
} from "../src/nav/index.js";
import {
  RendezvousWalletSelectionStrategy,
  StickyWalletAllocator,
  type WalletAssignment,
} from "../src/wallets/index.js";

describe("NAV snapshots", () => {
  it("includes idle pUSD and projects exact-second management dilution", async () => {
    const lastAccrual = 2_000_000_000n;
    const observedSeconds = lastAccrual + MANAGEMENT_FEE_PERIOD_SECS / 2n;
    let persisted: NavSnapshot | undefined;
    const service = new NavSnapshotService(
      {
        loadBasketState: async () => ({
          basketId: "basket-a",
          ledgerVersion: "ledger:10",
          compositionVersion: 2n,
          compositionHash: "ab".repeat(32),
          idlePusdUnits: 50_000_000n,
          holdings: [
            {
              marketId: "100",
              tokenId: "1000",
              outcome: "Yes",
              quantityUnits: 100_000_000n,
              markPriceUnits: 500_000n,
              priceScale: 1_000_000n,
              markObservedAtMs: observedSeconds * 1_000n,
              markSourceHash: "clob:book:1",
              markCondition: "fresh",
            },
          ],
        }),
      },
      {
        loadShareSupply: async () => ({
          totalSharesUnits: 100_000_000n,
          protocolFeeSharesUnits: 0n,
          lastManagementFeeAtSeconds: lastAccrual,
          managementFeeAccrualRemainder: 0n,
          sourceSlot: 99n,
          sourceVersion: "solana:99:basket-a",
        }),
      },
      {
        nextSequence: async () => 1n,
        append: async (snapshot) => {
          persisted = snapshot;
        },
      },
      {
        resolve: async () => {
          throw new Error("fallback should not be called");
        },
      },
      { nowMs: () => observedSeconds * 1_000n },
      { maxMarkAgeMs: 60_000n },
    );
    const snapshot = await service.createSnapshot("basket-a");
    const projected = accrueManagementFee(
      {
        totalSharesOutstanding: 100_000_000n,
        protocolFeeShares: 0n,
        lastManagementFeeAt: lastAccrual,
        managementFeeAccrualRemainder: 0n,
      },
      observedSeconds,
    );
    assert.equal(snapshot.positionValuePusdUnits, 50_000_000n);
    assert.equal(snapshot.grossNavPusdUnits, 100_000_000n);
    assert.equal(snapshot.totalSharesUnits, projected.totalSharesOutstanding);
    assert.equal(
      snapshot.projectedManagementFeeSharesUnits,
      projected.mintedShares,
    );
    assert.equal(
      snapshot.sharePriceUnits,
      (100_000_000n * NAV_SHARE_PRICE_SCALE) /
        projected.totalSharesOutstanding,
    );
    assert.equal(persisted?.hash, snapshot.hash);
  });

  it("uses complete fallback mark provenance in the immutable snapshot", async () => {
    const nowMs = 2_000_000_000_000n;
    const service = new NavSnapshotService(
      {
        loadBasketState: async () => ({
          basketId: "basket-a",
          ledgerVersion: "ledger:11",
          compositionVersion: 1n,
          compositionHash: "cd".repeat(32),
          idlePusdUnits: 0n,
          holdings: [
            {
              marketId: "100",
              tokenId: "1000",
              outcome: "Yes",
              quantityUnits: 10_000_000n,
              markPriceUnits: 400_000n,
              priceScale: 1_000_000n,
              markObservedAtMs: nowMs - 1_000_000n,
              markSourceHash: "stale-source",
              markCondition: "stale",
            },
          ],
        }),
      },
      {
        loadShareSupply: async () => ({
          totalSharesUnits: 10_000_000n,
          protocolFeeSharesUnits: 0n,
          lastManagementFeeAtSeconds: nowMs / 1_000n,
          managementFeeAccrualRemainder: 0n,
          sourceSlot: 1n,
          sourceVersion: "slot:1",
        }),
      },
      { nextSequence: async () => 1n, append: async () => undefined },
      {
        resolve: async () => ({
          priceUnits: 450_000n,
          observedAtMs: nowMs - 1_000n,
          sourceHash: "fallback:oracle:42",
        }),
      },
      { nowMs: () => nowMs },
      { maxMarkAgeMs: 60_000n },
    );
    const snapshot = await service.createSnapshot("basket-a");
    assert.equal(snapshot.holdings[0]?.markPriceUnits, 450_000n);
    assert.equal(snapshot.holdings[0]?.markSourceHash, "fallback:oracle:42");
    assert.equal(snapshot.holdings[0]?.markObservedAtMs, nowMs - 1_000n);
  });
});

describe("sticky execution-wallet allocation", () => {
  it("keeps an existing basket assignment while remaining shard-ready", async () => {
    const assignments = new Map<string, WalletAssignment>();
    const store = {
      findByBasketId: async (basketId: string) => assignments.get(basketId) ?? null,
      putIfAbsent: async (candidate: WalletAssignment) => {
        const value = assignments.get(candidate.basketId) ?? candidate;
        assignments.set(candidate.basketId, value);
        return value;
      },
    };
    let wallets = [
      {
        walletId: "wallet-a",
        polygonAddress: `0x${"11".repeat(20)}`,
        shard: "shard-0",
        status: "active" as const,
      },
    ];
    const allocator = new StickyWalletAllocator(
      store,
      { listWallets: async () => wallets },
      new RendezvousWalletSelectionStrategy(),
      { nowMs: () => 123n },
    );
    const first = await allocator.allocate("basket-a");
    wallets = [
      ...wallets,
      {
        walletId: "wallet-b",
        polygonAddress: `0x${"22".repeat(20)}`,
        shard: "shard-1",
        status: "active" as const,
      },
    ];
    const second = await allocator.allocate("basket-a");
    assert.deepEqual(second, first);
    assert.equal(first.walletId, "wallet-a");
  });
});
