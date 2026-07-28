export interface FaultContext {
  readonly operationId: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export const FINANCIAL_FAULT_POINTS = Object.freeze([
  "deposit.bridge_address_created",
  "deposit.fak_order_executed",
  "deposit.jupiter_swap_executed",
  "deposit.settlement_submitted",
  "withdrawal.fak_order_executed",
  "withdrawal.jupiter_swap_executed",
  "withdrawal.bridge_address_created",
  "withdrawal.pusd_transfer_submitted",
  "withdrawal.fee_split_submitted",
  "withdrawal.settlement_submitted",
  "protocol_fee.fak_order_executed",
  "protocol_fee.jupiter_swap_executed",
  "protocol_fee.bridge_address_created",
  "protocol_fee.pusd_transfer_submitted",
  "protocol_fee.distribution_submitted",
  "protocol_fee.settlement_submitted",
  "reconstitution.onchain_started",
  "reconstitution.fak_order_executed",
  "reconstitution.jupiter_swap_executed",
  "reconstitution.external_execution_completed",
  "reconstitution.onchain_completed",
  "resolution.onchain_started",
  "resolution.condition_redeemed",
  "resolution.external_execution_completed",
  "resolution.final_settlement_recorded",
] as const);

export type FinancialFaultPoint = typeof FINANCIAL_FAULT_POINTS[number];

export interface FaultInjectorPort {
  after(point: FinancialFaultPoint, context: FaultContext): Promise<void>;
}

export const NOOP_FAULT_INJECTOR: FaultInjectorPort = Object.freeze({
  after: async () => undefined,
});

/** Test-only deterministic injector: each configured point fails once. */
export class FailOnceFaultInjector implements FaultInjectorPort {
  private readonly remaining: Set<string>;

  public constructor(points: readonly (FinancialFaultPoint | `${string}:${FinancialFaultPoint}`)[]) {
    this.remaining = new Set(points);
  }

  public async after(point: FinancialFaultPoint, context: FaultContext): Promise<void> {
    const key = `${context.operationId}:${point}`;
    if (this.remaining.delete(key) || this.remaining.delete(point)) {
      throw new Error(`fault injected after ${point}`);
    }
  }
}
