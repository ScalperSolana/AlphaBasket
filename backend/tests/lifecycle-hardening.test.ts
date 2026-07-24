import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PublicKey } from "@solana/web3.js";

import {
  InMemoryDistributedLeaseStore,
  InMemoryLifecycleRunStore,
  ManagementFeeKeeper,
  ReconstitutionWorkflow,
  ResolutionWorkflow,
  type LifecycleSolanaGatewayPort,
} from "../src/lifecycle/index.js";
import {
  PostgresCanaryUsageStore,
  ProductionCanaryGuard,
  type CanaryUsageStorePort,
} from "../src/operations/index.js";
import {
  ReconciliationService,
  type ReconciliationRun,
} from "../src/reconciliation/index.js";
import {
  executeWithProviderRetry,
  FailOnceFaultInjector,
  ProviderRetryExhaustedError,
} from "../src/resilience/index.js";
import {
  WalletExecutionCoordinator,
  type WalletOperationLease,
  type WalletOperationLeaseStorePort,
} from "../src/wallets/index.js";

const basket = new PublicKey(new Uint8Array(32).fill(31));
const now = new Date(2_000_000_000_000);

function gateway(overrides: Partial<LifecycleSolanaGatewayPort> = {}): LifecycleSolanaGatewayPort {
  const result = { transactionSignature: "tx", finalizedSlot: 1n };
  return {
    accrueManagementFee: async () => result,
    beginReconstitution: async () => result,
    completeReconstitution: async () => result,
    beginResolution: async () => result,
    recordFinalSettlement: async () => ({ ...result, finalShareSnapshot: 100n }),
    ...overrides,
  };
}

describe("lifecycle automation", () => {
  it("leases and accrues only due baskets while isolating failures", async () => {
    const called: string[] = [];
    const keeper = new ManagementFeeKeeper(
      {
        listBaskets: async () => [
          {
            address: basket,
            basketId: new Uint8Array(32).fill(1),
            status: "active" as const,
            isPerpetual: true,
            compositionVersion: 1,
            lastCompositionNonce: 1n,
            lastManagementFeeAtSeconds: BigInt(now.getTime() / 1_000) - 86_400n,
            lastReconstitutionAtSeconds: 0n,
            reconstitutionCadenceSeconds: 2_592_000n,
            totalSharesOutstanding: 1_000_000n,
          },
          {
            address: new PublicKey(new Uint8Array(32).fill(32)),
            basketId: new Uint8Array(32).fill(2),
            status: "active" as const,
            isPerpetual: true,
            compositionVersion: 1,
            lastCompositionNonce: 1n,
            lastManagementFeeAtSeconds: BigInt(now.getTime() / 1_000),
            lastReconstitutionAtSeconds: 0n,
            reconstitutionCadenceSeconds: 2_592_000n,
            totalSharesOutstanding: 1_000_000n,
          },
        ],
        loadBasket: async () => { throw new Error("unused"); },
      },
      new InMemoryDistributedLeaseStore(),
      gateway({ accrueManagementFee: async (address) => {
        called.push(address.toBase58());
        return { transactionSignature: "fee-tx", finalizedSlot: 9n };
      } }),
      { now: () => now },
      {
        ownerId: "keeper-1",
        scanLimit: 100,
        minimumAccrualIntervalSeconds: 3_600n,
        leaseDurationMs: 30_000,
      },
    );
    const result = await keeper.runOnce();
    assert.equal(result.scanned, 2);
    assert.equal(result.accrued, 1);
    assert.equal(result.skippedNotDue, 1);
    assert.deepEqual(called, [basket.toBase58()]);
  });

  it("resumes reconstitution after a crash following external execution", async () => {
    const runs = new InMemoryLifecycleRunStore();
    let beginCalls = 0;
    let completedCalls = 0;
    let executionCalls = 0;
    const authorization = {
      basket,
      basketId: new Uint8Array(32).fill(7),
      nextCompositionVersion: 2,
      compositionHash: new Uint8Array(32).fill(8),
      items: [{
        marketId: "market-a",
        kind: { predictionMarket: { outcome: 1, ctfTokenId: new Uint8Array(32).fill(9) } },
        weightBps: 10_000,
      }],
      compositionNonce: 2n,
      compositionExpirySeconds: 2_000_000_100n,
      encodedMessage: new Uint8Array([1]),
      composerPublicKey: new Uint8Array(32).fill(10),
      composerSignature: new Uint8Array(64).fill(11),
    } as const;
    const workflow = new ReconstitutionWorkflow(
      runs,
      gateway({
        beginReconstitution: async () => {
          beginCalls += 1;
          return { transactionSignature: "begin", finalizedSlot: 1n };
        },
        completeReconstitution: async () => {
          completedCalls += 1;
          return { transactionSignature: "complete", finalizedSlot: 3n };
        },
      }),
      { rebalance: async () => {
        executionCalls += 1;
        return {
          executionHash: "ab".repeat(32),
          orderIds: ["order-1"],
          realizedPusdDeltaUnits: 0n,
          executedAtMs: BigInt(now.getTime()),
        };
      } },
      { now: () => now },
      new FailOnceFaultInjector(["reconstitution.external_execution_completed"]),
    );
    const request = {
      id: "10000000-0000-4000-8000-000000000001",
      runKey: "reconstitution:basket:2",
      authorization,
    } as const;
    await assert.rejects(workflow.execute(request), /fault injected/u);
    const result = await workflow.execute(request);
    assert.equal(result.run.state, "onchain_completed");
    assert.equal(beginCalls, 1);
    assert.equal(executionCalls, 2);
    assert.equal(completedCalls, 1);
    await assert.rejects(workflow.execute({
      ...request,
      authorization: { ...authorization, composerSignature: new Uint8Array(64).fill(12) },
    }), /different content/u);
    assert.equal(completedCalls, 1);
  });

  it("records a resolution report and the contract-selected final share snapshot", async () => {
    const workflow = new ResolutionWorkflow(
      new InMemoryLifecycleRunStore(),
      gateway({ recordFinalSettlement: async (request) => {
        assert.equal(request.finalNavValue, 90_000_000n);
        return { transactionSignature: "final", finalizedSlot: 7n, finalShareSnapshot: 80_000_000n };
      } }),
      { resolve: async () => ({
        executionHash: "cd".repeat(32),
        finalReportHash: new Uint8Array(32).fill(12),
        finalNavValue: 90_000_000n,
        externalReferences: ["polygon:redeem:1"],
        executedAtMs: BigInt(now.getTime()),
      }) },
      { now: () => now },
    );
    const result = await workflow.execute({
      id: "20000000-0000-4000-8000-000000000002",
      runKey: "resolution:basket:1",
      basket,
    });
    assert.equal(result.run.state, "onchain_completed");
    assert.equal(result.settlement.finalShareSnapshot, 80_000_000n);
  });
});

describe("reconciliation", () => {
  it("persists and alerts on supply, wallet, NAV and stuck-operation drift", async () => {
    let persisted: ReconciliationRun | undefined;
    let alerted = 0;
    const service = new ReconciliationService(
      {
        listBasketIds: async () => ["basket-a"],
        observeBasket: async () => ({
          basketId: "basket-a",
          onchainTotalSharesUnits: 100n,
          positionShareSumUnits: 99n,
          protocolFeeSharesUnits: 0n,
          ledgerAttributedPusdUnits: 1_000n,
          walletAttributedPusdUnits: 900n,
          navGrossPusdUnits: 850n,
          navObservedAtMs: BigInt(now.getTime()) - 120_000n,
          oldestPendingOperationAtMs: BigInt(now.getTime()) - 600_000n,
        }),
      },
      {
        append: async (run) => { persisted = run; },
        latest: async () => [],
      },
      { publish: async (_run, findings) => { alerted += findings.length; } },
      { now: () => now },
      {
        scope: "test",
        scanLimit: 100,
        assetToleranceUnits: 10n,
        maxNavAgeMs: 60_000n,
        maxPendingOperationAgeMs: 300_000n,
      },
    );
    const run = await service.runOnce();
    assert.equal(run.status, "critical");
    assert.deepEqual(run.findings.map((finding) => finding.code).sort(), [
      "nav_ledger_mismatch",
      "share_supply_mismatch",
      "stale_nav",
      "stuck_operation",
      "wallet_attribution_mismatch",
    ]);
    assert.equal(alerted, 5);
    assert.equal(persisted?.id, run.id);
  });
});

describe("provider resilience, wallet contention and canary limits", () => {
  it("uses bounded deterministic provider retries", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await executeWithProviderRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("provider unavailable");
      return "ok";
    }, { sleep: async (duration) => { delays.push(duration); } }, {
      operation: "clob-order",
      safety: { kind: "idempotent_write", idempotencyKey: "order:deposit:1" },
      timeoutMs: 1_000,
      maximumAttempts: 3,
      initialBackoffMs: 100,
      maximumBackoffMs: 1_000,
      retryable: () => true,
    });
    assert.equal(result, "ok");
    assert.deepEqual(delays, [100, 200]);
  });

  it("times out a stalled provider call and exhausts its bounded attempts", async () => {
    let attempts = 0;
    await assert.rejects(executeWithProviderRetry(async () => {
      attempts += 1;
      return new Promise<never>(() => undefined);
    }, { sleep: async () => undefined }, {
      operation: "bridge-status",
      safety: { kind: "read" },
      timeoutMs: 5,
      maximumAttempts: 2,
      initialBackoffMs: 1,
      maximumBackoffMs: 1,
      retryable: () => true,
    }), ProviderRetryExhaustedError);
    assert.equal(attempts, 2);
  });

  it("refuses retryable writes without a stable idempotency key", async () => {
    await assert.rejects(executeWithProviderRetry(async () => "unexpected", { sleep: async () => undefined }, {
      operation: "clob-order",
      safety: { kind: "idempotent_write", idempotencyKey: "" },
      timeoutMs: 100,
      maximumAttempts: 2,
      initialBackoffMs: 1,
      maximumBackoffMs: 1,
      retryable: () => true,
    }), /idempotency key/u);
  });

  it("serializes a hot wallet while allowing replay of the same operation", async () => {
    const active = new Map<string, WalletOperationLease>();
    const store: WalletOperationLeaseStorePort = {
      tryAcquire: async (request) => {
        const existing = active.get(request.operationId);
        if (existing !== undefined) return existing;
        if (active.size >= 1) return null;
        const lease = {
          walletId: request.walletId,
          operationId: request.operationId,
          ownerId: request.ownerId,
          token: request.operationId,
          acquiredAt: request.now,
          expiresAt: new Date(request.now.getTime() + request.durationMs),
        };
        active.set(request.operationId, lease);
        return lease;
      },
      renew: async (lease) => lease,
      release: async (lease) => active.delete(lease.operationId),
    };
    const coordinator = new WalletExecutionCoordinator(store, "worker", 30_000);
    let unblock: (() => void) | undefined;
    const first = coordinator.execute("wallet-a", "op-a", async () => new Promise<string>((resolve) => { unblock = () => resolve("done"); }));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(coordinator.execute("wallet-a", "op-b", async () => "unexpected"), /at capacity/u);
    unblock?.();
    assert.equal(await first, "done");
  });

  it("enforces production canary allowlists and daily limits", async () => {
    let used = 0n;
    const usage: CanaryUsageStorePort = {
      reserve: async (request) => {
        if (used + request.amountUnits > request.maximumDailyUnits) throw new Error("canary daily capital limit exceeded");
        used += request.amountUnits;
      },
    };
    const guard = new ProductionCanaryGuard({
      deploymentMode: "production_canary",
      accountingSolanaCluster: "mainnet-beta",
      capitalSolanaCluster: "mainnet-beta",
      polymarketChainId: 137,
      capitalMode: "live_bridge",
      maximumOperationUnits: 10_000_000n,
      maximumDailyUnits: 15_000_000n,
      allowedBasketIds: new Set(["basket-a"]),
      allowedWalletIds: new Set(["wallet-a"]),
    }, usage);
    await guard.authorize({ operationId: "op-1", basketId: "basket-a", walletId: "wallet-a", amountUnits: 10_000_000n, now });
    await assert.rejects(guard.authorize({ operationId: "op-2", basketId: "basket-a", walletId: "wallet-a", amountUnits: 6_000_000n, now }), /daily capital/u);
    await assert.rejects(guard.authorize({ operationId: "op-3", basketId: "basket-b", walletId: "wallet-a", amountUnits: 1n, now }), /not allowlisted/u);
  });

  it("allows devnet accounting with mainnet live bridge capital", () => {
    const guard = new ProductionCanaryGuard({
      deploymentMode: "hybrid_devnet",
      accountingSolanaCluster: "devnet",
      capitalSolanaCluster: "mainnet-beta",
      polymarketChainId: 137,
      capitalMode: "live_bridge",
      maximumOperationUnits: 1n,
      maximumDailyUnits: 1n,
      allowedBasketIds: new Set(),
      allowedWalletIds: new Set(),
    }, new PostgresCanaryUsageStore({} as never));
    assert.ok(guard);
  });

  it("requires coherent production canary capital limits", () => {
    assert.throws(() => new ProductionCanaryGuard({
      deploymentMode: "production_canary",
      accountingSolanaCluster: "mainnet-beta",
      capitalSolanaCluster: "mainnet-beta",
      polymarketChainId: 137,
      capitalMode: "live_bridge",
      maximumOperationUnits: 2n,
      maximumDailyUnits: 1n,
      allowedBasketIds: new Set(),
      allowedWalletIds: new Set(),
    }, new PostgresCanaryUsageStore({} as never)), /daily units/u);
  });
});
