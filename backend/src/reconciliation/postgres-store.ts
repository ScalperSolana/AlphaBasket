import type { SqlClient } from "../persistence/sql-client.js";
import type {
  BasketReconciliationObservation,
  ReconciliationFinding,
  ReconciliationRun,
  ReconciliationStatus,
  ReconciliationStorePort,
} from "./types.js";

interface RunRow extends Record<string, unknown> {
  id: string;
  scope: string;
  observed_at: Date;
  status: ReconciliationStatus;
  snapshot: {
    readonly observations: readonly Record<string, string | null>[];
    readonly findings: readonly SerializedFinding[];
  };
}

interface SerializedFinding {
  readonly id: string;
  readonly dedupeKey: string;
  readonly basketId: string;
  readonly code: ReconciliationFinding["code"];
  readonly severity: ReconciliationFinding["severity"];
  readonly expectedValue?: string;
  readonly actualValue?: string;
  readonly details: Readonly<Record<string, string>>;
  readonly observedAt: string;
}

const serializeObservation = (value: BasketReconciliationObservation): Record<string, string | null> => ({
  basketId: value.basketId,
  onchainTotalSharesUnits: value.onchainTotalSharesUnits.toString(10),
  positionShareSumUnits: value.positionShareSumUnits.toString(10),
  protocolFeeSharesUnits: value.protocolFeeSharesUnits.toString(10),
  ledgerAttributedPusdUnits: value.ledgerAttributedPusdUnits.toString(10),
  walletAttributedPusdUnits: value.walletAttributedPusdUnits.toString(10),
  navGrossPusdUnits: value.navGrossPusdUnits.toString(10),
  navObservedAtMs: value.navObservedAtMs.toString(10),
  oldestPendingOperationAtMs: value.oldestPendingOperationAtMs?.toString(10) ?? null,
});

const parseObservation = (value: Record<string, string | null>): BasketReconciliationObservation => {
  const required = (key: string): string => {
    const result = value[key];
    if (typeof result !== "string") throw new Error(`invalid reconciliation observation ${key}`);
    return result;
  };
  const pending = value.oldestPendingOperationAtMs;
  return Object.freeze({
    basketId: required("basketId"),
    onchainTotalSharesUnits: BigInt(required("onchainTotalSharesUnits")),
    positionShareSumUnits: BigInt(required("positionShareSumUnits")),
    protocolFeeSharesUnits: BigInt(required("protocolFeeSharesUnits")),
    ledgerAttributedPusdUnits: BigInt(required("ledgerAttributedPusdUnits")),
    walletAttributedPusdUnits: BigInt(required("walletAttributedPusdUnits")),
    navGrossPusdUnits: BigInt(required("navGrossPusdUnits")),
    navObservedAtMs: BigInt(required("navObservedAtMs")),
    oldestPendingOperationAtMs: pending === null || pending === undefined ? null : BigInt(pending),
  });
};

const serializeFinding = (value: ReconciliationFinding): SerializedFinding => ({
  id: value.id,
  dedupeKey: value.dedupeKey,
  basketId: value.basketId,
  code: value.code,
  severity: value.severity,
  ...(value.expectedValue === undefined ? {} : { expectedValue: value.expectedValue }),
  ...(value.actualValue === undefined ? {} : { actualValue: value.actualValue }),
  details: value.details,
  observedAt: value.observedAt.toISOString(),
});

const parseFinding = (value: SerializedFinding): ReconciliationFinding => Object.freeze({
  ...value,
  details: Object.freeze({ ...value.details }),
  observedAt: new Date(value.observedAt),
});

export class PostgresReconciliationStore implements ReconciliationStorePort {
  public constructor(private readonly sql: SqlClient) {}

  public async append(run: ReconciliationRun): Promise<void> {
    await this.sql.transaction(async (transaction) => {
      const snapshot = {
        observations: run.observations.map(serializeObservation),
        findings: run.findings.map(serializeFinding),
      };
      await transaction.query(
        `INSERT INTO reconciliation_runs (id, scope, observed_at, status, snapshot)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [run.id, run.scope, run.observedAt, run.status, JSON.stringify(snapshot)],
      );
      for (const finding of run.findings) {
        await transaction.query(
          `INSERT INTO reconciliation_findings (
             id, run_id, dedupe_key, basket_id, code, severity,
             expected_value, actual_value, details, observed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
          [
            finding.id,
            run.id,
            finding.dedupeKey,
            finding.basketId,
            finding.code,
            finding.severity,
            finding.expectedValue ?? null,
            finding.actualValue ?? null,
            JSON.stringify(finding.details),
            finding.observedAt,
          ],
        );
      }
    });
  }

  public async latest(scope: string, limit: number): Promise<readonly ReconciliationRun[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) throw new RangeError("reconciliation limit must be between 1 and 100");
    const result = await this.sql.query<RunRow>(
      `SELECT id, scope, observed_at, status, snapshot
       FROM reconciliation_runs WHERE scope = $1
       ORDER BY observed_at DESC, id DESC LIMIT $2`,
      [scope, limit],
    );
    return Object.freeze(result.rows.map((row) => Object.freeze({
      id: row.id,
      scope: row.scope,
      observedAt: row.observed_at,
      status: row.status,
      observations: Object.freeze(row.snapshot.observations.map(parseObservation)),
      findings: Object.freeze(row.snapshot.findings.map(parseFinding)),
    })));
  }
}
