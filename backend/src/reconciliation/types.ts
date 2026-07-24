export type ReconciliationSeverity = "warning" | "critical";
export type ReconciliationStatus = "healthy" | "degraded" | "critical";

export interface BasketReconciliationObservation {
  readonly basketId: string;
  readonly onchainTotalSharesUnits: bigint;
  readonly positionShareSumUnits: bigint;
  readonly protocolFeeSharesUnits: bigint;
  readonly ledgerAttributedPusdUnits: bigint;
  readonly walletAttributedPusdUnits: bigint;
  readonly navGrossPusdUnits: bigint;
  readonly navObservedAtMs: bigint;
  readonly oldestPendingOperationAtMs: bigint | null;
}

export interface ReconciliationSourcePort {
  listBasketIds(limit: number): Promise<readonly string[]>;
  observeBasket(basketId: string): Promise<BasketReconciliationObservation>;
}

export interface ReconciliationFinding {
  readonly id: string;
  readonly dedupeKey: string;
  readonly basketId: string;
  readonly code:
    | "share_supply_mismatch"
    | "wallet_attribution_mismatch"
    | "nav_ledger_mismatch"
    | "stale_nav"
    | "stuck_operation";
  readonly severity: ReconciliationSeverity;
  readonly expectedValue?: string;
  readonly actualValue?: string;
  readonly details: Readonly<Record<string, string>>;
  readonly observedAt: Date;
}

export interface ReconciliationRun {
  readonly id: string;
  readonly scope: string;
  readonly observedAt: Date;
  readonly status: ReconciliationStatus;
  readonly observations: readonly BasketReconciliationObservation[];
  readonly findings: readonly ReconciliationFinding[];
}

export interface ReconciliationStorePort {
  append(run: ReconciliationRun): Promise<void>;
  latest(scope: string, limit: number): Promise<readonly ReconciliationRun[]>;
}

export interface ReconciliationAlertSinkPort {
  publish(run: ReconciliationRun, findings: readonly ReconciliationFinding[]): Promise<void>;
}

export interface ReconciliationClockPort {
  now(): Date;
}
