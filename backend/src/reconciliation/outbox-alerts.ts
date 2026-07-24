import { randomUUID } from "node:crypto";

import type { TransactionalOutboxRepository } from "../persistence/outbox.js";
import type {
  ReconciliationAlertSinkPort,
  ReconciliationFinding,
  ReconciliationRun,
} from "./types.js";

export class OutboxReconciliationAlertSink implements ReconciliationAlertSinkPort {
  public constructor(private readonly outbox: TransactionalOutboxRepository) {}

  public async publish(run: ReconciliationRun, findings: readonly ReconciliationFinding[]): Promise<void> {
    for (const finding of findings) {
      await this.outbox.enqueue({
        id: randomUUID(),
        topic: "reconciliation.finding.detected",
        aggregateType: "basket",
        aggregateId: finding.basketId,
        dedupeKey: `${finding.dedupeKey}:${run.observedAt.toISOString()}`,
        payload: {
          runId: run.id,
          scope: run.scope,
          basketId: finding.basketId,
          code: finding.code,
          severity: finding.severity,
          expectedValue: finding.expectedValue ?? null,
          actualValue: finding.actualValue ?? null,
          details: finding.details,
          observedAt: finding.observedAt.toISOString(),
        },
        occurredAt: finding.observedAt,
      });
    }
  }
}
