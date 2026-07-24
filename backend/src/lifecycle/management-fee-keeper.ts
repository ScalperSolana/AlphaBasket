import type { DistributedLeaseStorePort } from "./lease.js";
import type {
  ClockPort,
  LifecycleBasketSourcePort,
  LifecycleSolanaGatewayPort,
} from "./types.js";

export interface ManagementFeeKeeperOptions {
  readonly ownerId: string;
  readonly scanLimit: number;
  readonly minimumAccrualIntervalSeconds: bigint;
  readonly leaseDurationMs: number;
}

export interface ManagementFeeKeeperResult {
  readonly scanned: number;
  readonly accrued: number;
  readonly skippedNotDue: number;
  readonly skippedLeased: number;
  readonly failures: readonly Readonly<{ basket: string; error: string }>[];
}

export class ManagementFeeKeeper {
  public constructor(
    private readonly baskets: LifecycleBasketSourcePort,
    private readonly leases: DistributedLeaseStorePort,
    private readonly gateway: LifecycleSolanaGatewayPort,
    private readonly clock: ClockPort,
    private readonly options: ManagementFeeKeeperOptions,
  ) {
    if (!Number.isSafeInteger(options.scanLimit) || options.scanLimit <= 0 || options.scanLimit > 10_000) {
      throw new RangeError("management fee scanLimit must be between 1 and 10000");
    }
    if (options.minimumAccrualIntervalSeconds <= 0n) {
      throw new RangeError("minimum accrual interval must be positive");
    }
  }

  public async runOnce(): Promise<ManagementFeeKeeperResult> {
    const now = this.clock.now();
    const nowSeconds = BigInt(Math.floor(now.getTime() / 1_000));
    const candidates = await this.baskets.listBaskets(["active", "reconstituting", "resolving"], this.options.scanLimit);
    let accrued = 0;
    let skippedNotDue = 0;
    let skippedLeased = 0;
    const failures: { basket: string; error: string }[] = [];

    for (const basket of candidates) {
      if (basket.totalSharesOutstanding === 0n) {
        skippedNotDue += 1;
        continue;
      }
      const elapsed = nowSeconds - basket.lastManagementFeeAtSeconds;
      if (basket.lastManagementFeeAtSeconds > 0n && elapsed < this.options.minimumAccrualIntervalSeconds) {
        skippedNotDue += 1;
        continue;
      }
      const address = basket.address.toBase58();
      const lease = await this.leases.tryAcquire(
        `management-fee:${address}`,
        this.options.ownerId,
        now,
        this.options.leaseDurationMs,
      );
      if (lease === null) {
        skippedLeased += 1;
        continue;
      }
      try {
        const epoch = nowSeconds / this.options.minimumAccrualIntervalSeconds;
        await this.gateway.accrueManagementFee(basket.address, `management-fee:${address}:${epoch.toString(10)}`);
        accrued += 1;
      } catch (error) {
        failures.push({ basket: address, error: error instanceof Error ? error.message : "unknown keeper failure" });
      } finally {
        await this.leases.release(lease).catch(() => false);
      }
    }

    return Object.freeze({
      scanned: candidates.length,
      accrued,
      skippedNotDue,
      skippedLeased,
      failures: Object.freeze(failures.map((failure) => Object.freeze(failure))),
    });
  }
}
