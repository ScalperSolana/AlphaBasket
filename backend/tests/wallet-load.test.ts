import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemoryWalletOperationLeaseStore,
  RendezvousWalletSelectionStrategy,
  WalletExecutionCoordinator,
} from "../src/wallets/index.js";

describe("wallet sharding load", () => {
  it("distributes twenty thousand baskets without a hot shard", () => {
    const wallets = Array.from({ length: 8 }, (_, index) => ({
      walletId: `wallet-${index}`,
      polygonAddress: `0x${(index + 1).toString(16).padStart(40, "0")}`,
      shard: `shard-${index}`,
      status: "active" as const,
      maxConcurrentOperations: 10,
    }));
    const strategy = new RendezvousWalletSelectionStrategy();
    const counts = new Map(wallets.map((wallet) => [wallet.walletId, 0]));
    for (let index = 0; index < 20_000; index += 1) {
      const selected = strategy.select(`basket-${index}`, wallets);
      counts.set(selected.walletId, (counts.get(selected.walletId) ?? 0) + 1);
    }
    const values = [...counts.values()];
    assert.equal(values.reduce((sum, value) => sum + value, 0), 20_000);
    assert.equal(Math.max(...values) < 3_000, true);
    assert.equal(Math.min(...values) > 2_000, true);
  });

  it("never exceeds a shared wallet's configured concurrency under a burst", async () => {
    const coordinator = new WalletExecutionCoordinator(
      new InMemoryWalletOperationLeaseStore(new Map([["wallet-hot", 10]])),
      "load-worker",
      30_000,
    );
    let active = 0;
    let maximumActive = 0;
    const results = await Promise.allSettled(Array.from({ length: 500 }, (_, index) =>
      coordinator.execute("wallet-hot", `operation-${index}`, async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return index;
      }),
    ));
    const succeeded = results.filter((result) => result.status === "fulfilled").length;
    assert.equal(maximumActive, 10);
    assert.equal(succeeded, 10);
    assert.equal(results.length - succeeded, 490);
  });

  it("does not run the same operation concurrently under an active lease", async () => {
    const coordinator = new WalletExecutionCoordinator(
      new InMemoryWalletOperationLeaseStore(new Map([["wallet-one", 1]])),
      "worker-one",
      30_000,
    );
    let finish: (() => void) | undefined;
    const first = coordinator.execute("wallet-one", "same-operation", async () => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      coordinator.execute("wallet-one", "same-operation", async () => undefined),
      /at capacity/u,
    );
    finish?.();
    await first;
  });
});
