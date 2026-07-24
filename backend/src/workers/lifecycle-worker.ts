import type { ManagementFeeKeeper } from "../lifecycle/index.js";
import type { OutboxDispatcher } from "../persistence/index.js";
import type { ReconciliationService } from "../reconciliation/index.js";
import type { PeriodicTask } from "./periodic-runner.js";

export function lifecycleAutomationTasks(
  keeper: ManagementFeeKeeper,
  reconciliation: ReconciliationService,
  options: Readonly<{
    managementFeeIntervalMs: number;
    reconciliationIntervalMs: number;
    outboxIntervalMs?: number;
    outbox?: OutboxDispatcher;
  }>,
): readonly PeriodicTask[] {
  const tasks: PeriodicTask[] = [
    Object.freeze({
      name: "management-fee-keeper",
      intervalMs: options.managementFeeIntervalMs,
      run: async () => { await keeper.runOnce(); },
    }),
    Object.freeze({
      name: "reconciliation",
      intervalMs: options.reconciliationIntervalMs,
      run: async () => { await reconciliation.runOnce(); },
    }),
  ];
  if (options.outbox !== undefined) {
    if (options.outboxIntervalMs === undefined) throw new Error("outbox interval is required when the dispatcher is configured");
    tasks.push(Object.freeze({
      name: "outbox-dispatcher",
      intervalMs: options.outboxIntervalMs,
      run: async () => { await options.outbox?.runOnce(); },
    }));
  }
  return Object.freeze(tasks);
}
