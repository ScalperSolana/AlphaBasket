import type {
  SolanaAccountIndexer,
  SolanaEventIndexer,
} from "../indexer/index.js";
import type {
  BasketMarkRefreshPort,
  NavBasketRegistryPort,
  NavSnapshotService,
} from "../nav/index.js";
import type { PeriodicTask } from "./periodic-runner.js";

export function indexerTasks(
  accounts: SolanaAccountIndexer,
  events: SolanaEventIndexer,
  options: Readonly<{ accountIntervalMs: number; eventIntervalMs: number }>,
): readonly PeriodicTask[] {
  return Object.freeze([
    Object.freeze({
      name: "solana-finalized-accounts",
      intervalMs: options.accountIntervalMs,
      run: async () => { await accounts.sync(); },
    }),
    Object.freeze({
      name: "solana-finalized-events",
      intervalMs: options.eventIntervalMs,
      run: async () => { await events.sync(); },
    }),
  ]);
}

export class NavSnapshotScheduler {
  public constructor(
    private readonly baskets: NavBasketRegistryPort,
    private readonly marks: BasketMarkRefreshPort,
    private readonly snapshots: NavSnapshotService,
    private readonly scanLimit: number,
  ) {}

  public async runOnce(): Promise<number> {
    const basketIds = await this.baskets.listBasketIds(this.scanLimit);
    const failures: Error[] = [];
    for (const basketId of basketIds) {
      try {
        await this.marks.refresh(basketId);
        await this.snapshots.createSnapshot(basketId);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(`NAV snapshot failed for ${basketId}`));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length.toString()} NAV basket(s) failed`);
    }
    return basketIds.length;
  }
}

export function navTasks(
  scheduler: NavSnapshotScheduler,
  intervalMs: number,
): readonly PeriodicTask[] {
  return Object.freeze([
    Object.freeze({
      name: "nav-snapshots",
      intervalMs,
      run: async () => { await scheduler.runOnce(); },
    }),
  ]);
}
