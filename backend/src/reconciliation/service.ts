import { createHash, randomUUID } from "node:crypto";

import type {
  BasketReconciliationObservation,
  ReconciliationAlertSinkPort,
  ReconciliationClockPort,
  ReconciliationFinding,
  ReconciliationRun,
  ReconciliationSeverity,
  ReconciliationSourcePort,
  ReconciliationStatus,
  ReconciliationStorePort,
} from "./types.js";

export interface ReconciliationOptions {
  readonly scope: string;
  readonly scanLimit: number;
  readonly assetToleranceUnits: bigint;
  readonly maxNavAgeMs: bigint;
  readonly maxPendingOperationAgeMs: bigint;
}

const difference = (left: bigint, right: bigint): bigint => left >= right ? left - right : right - left;

function statusFor(findings: readonly ReconciliationFinding[]): ReconciliationStatus {
  if (findings.some((finding) => finding.severity === "critical")) return "critical";
  if (findings.length > 0) return "degraded";
  return "healthy";
}

function findingId(scope: string, basketId: string, code: string, observedAt: Date): string {
  const hex = createHash("sha256")
    .update(JSON.stringify([scope, basketId, code, observedAt.toISOString()]), "utf8")
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function makeFinding(
  scope: string,
  observation: BasketReconciliationObservation,
  code: ReconciliationFinding["code"],
  severity: ReconciliationSeverity,
  observedAt: Date,
  expectedValue?: string,
  actualValue?: string,
  details: Readonly<Record<string, string>> = {},
): ReconciliationFinding {
  return Object.freeze({
    id: findingId(scope, observation.basketId, code, observedAt),
    dedupeKey: `${observation.basketId}:${code}`,
    basketId: observation.basketId,
    code,
    severity,
    ...(expectedValue === undefined ? {} : { expectedValue }),
    ...(actualValue === undefined ? {} : { actualValue }),
    details: Object.freeze({ ...details }),
    observedAt,
  });
}

export class ReconciliationService {
  public constructor(
    private readonly source: ReconciliationSourcePort,
    private readonly store: ReconciliationStorePort,
    private readonly alerts: ReconciliationAlertSinkPort,
    private readonly clock: ReconciliationClockPort,
    private readonly options: ReconciliationOptions,
  ) {
    if (!Number.isSafeInteger(options.scanLimit) || options.scanLimit <= 0 || options.scanLimit > 10_000) {
      throw new RangeError("reconciliation scanLimit must be between 1 and 10000");
    }
    if (options.assetToleranceUnits < 0n || options.maxNavAgeMs <= 0n || options.maxPendingOperationAgeMs <= 0n) {
      throw new RangeError("reconciliation tolerances and ages are invalid");
    }
  }

  public async runOnce(): Promise<ReconciliationRun> {
    const observedAt = this.clock.now();
    const nowMs = BigInt(observedAt.getTime());
    const basketIds = await this.source.listBasketIds(this.options.scanLimit);
    const observations: BasketReconciliationObservation[] = [];
    const findings: ReconciliationFinding[] = [];
    for (const basketId of basketIds) {
      const observation = await this.source.observeBasket(basketId);
      if (observation.basketId !== basketId) throw new Error("reconciliation source returned a different basket");
      const nonNegativeValues = [
        observation.onchainTotalSharesUnits,
        observation.positionShareSumUnits,
        observation.protocolFeeSharesUnits,
        observation.ledgerAttributedPusdUnits,
        observation.walletAttributedPusdUnits,
        observation.navGrossPusdUnits,
        observation.navObservedAtMs,
      ];
      if (nonNegativeValues.some((value) => value < 0n)) {
        throw new Error(`reconciliation source returned negative values for basket ${basketId}`);
      }
      if (observation.oldestPendingOperationAtMs !== null && observation.oldestPendingOperationAtMs < 0n) {
        throw new Error(`reconciliation source returned a negative pending-operation timestamp for basket ${basketId}`);
      }
      observations.push(Object.freeze({ ...observation }));
      const attributedShares = observation.positionShareSumUnits + observation.protocolFeeSharesUnits;
      if (observation.onchainTotalSharesUnits !== attributedShares) {
        findings.push(makeFinding(
          this.options.scope,
          observation,
          "share_supply_mismatch",
          "critical",
          observedAt,
          observation.onchainTotalSharesUnits.toString(10),
          attributedShares.toString(10),
          { userPositionShares: observation.positionShareSumUnits.toString(10), protocolFeeShares: observation.protocolFeeSharesUnits.toString(10) },
        ));
      }
      const walletDelta = difference(observation.ledgerAttributedPusdUnits, observation.walletAttributedPusdUnits);
      if (walletDelta > this.options.assetToleranceUnits) {
        findings.push(makeFinding(
          this.options.scope,
          observation,
          "wallet_attribution_mismatch",
          "critical",
          observedAt,
          observation.ledgerAttributedPusdUnits.toString(10),
          observation.walletAttributedPusdUnits.toString(10),
          { deltaUnits: walletDelta.toString(10) },
        ));
      }
      const navDelta = difference(observation.ledgerAttributedPusdUnits, observation.navGrossPusdUnits);
      if (navDelta > this.options.assetToleranceUnits) {
        findings.push(makeFinding(
          this.options.scope,
          observation,
          "nav_ledger_mismatch",
          "warning",
          observedAt,
          observation.ledgerAttributedPusdUnits.toString(10),
          observation.navGrossPusdUnits.toString(10),
          { deltaUnits: navDelta.toString(10) },
        ));
      }
      const navAge = nowMs - observation.navObservedAtMs;
      if (navAge < 0n || navAge > this.options.maxNavAgeMs) {
        findings.push(makeFinding(
          this.options.scope,
          observation,
          "stale_nav",
          navAge < 0n ? "critical" : "warning",
          observedAt,
          `<=${this.options.maxNavAgeMs.toString(10)}`,
          navAge.toString(10),
        ));
      }
      if (observation.oldestPendingOperationAtMs !== null) {
        const pendingAge = nowMs - observation.oldestPendingOperationAtMs;
        if (pendingAge > this.options.maxPendingOperationAgeMs) {
          findings.push(makeFinding(
            this.options.scope,
            observation,
            "stuck_operation",
            "critical",
            observedAt,
            `<=${this.options.maxPendingOperationAgeMs.toString(10)}`,
            pendingAge.toString(10),
          ));
        }
      }
    }
    const run: ReconciliationRun = Object.freeze({
      id: randomUUID(),
      scope: this.options.scope,
      observedAt,
      status: statusFor(findings),
      observations: Object.freeze(observations),
      findings: Object.freeze(findings),
    });
    await this.store.append(run);
    if (findings.length > 0) await this.alerts.publish(run, run.findings);
    return run;
  }
}
