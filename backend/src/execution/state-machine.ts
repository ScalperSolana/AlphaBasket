import type { ExecutionState } from "./types.js";

const ALLOWED: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = {
  created: ["intent_verified", "failed"],
  intent_verified: ["funding_verified", "trading_completed", "failed"],
  funding_verified: ["bridge_pending", "failed"],
  bridge_pending: ["bridge_pending", "bridge_completed", "failed"],
  bridge_completed: ["trading_completed", "settlement_submitted", "failed"],
  trading_completed: ["bridge_pending", "settlement_submitted", "failed"],
  settlement_submitted: ["settlement_submitted", "completed", "failed"],
  completed: [],
  failed: [],
};

export function assertExecutionTransition(current: ExecutionState, next: ExecutionState): void {
  if (!ALLOWED[current].includes(next)) throw new Error(`invalid execution transition ${current} -> ${next}`);
}
