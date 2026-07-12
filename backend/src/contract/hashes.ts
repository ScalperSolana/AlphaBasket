import { createHash } from "node:crypto";

import {
  depositIntentMessage,
  type DepositIntent,
  type WithdrawalIntent,
  withdrawalIntentMessage,
} from "./messages.js";
import { nonZeroBytes32 } from "./validation.js";

export function sha256(data: Uint8Array): Buffer {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError("data must be bytes");
  }
  return createHash("sha256").update(data).digest();
}

export function depositIntentHash(value: DepositIntent): Buffer {
  return sha256(depositIntentMessage(value));
}

export function withdrawalIntentHash(value: WithdrawalIntent): Buffer {
  return sha256(withdrawalIntentMessage(value));
}

/**
 * Validates the globally unique hash used as the SettlementReceipt PDA seed.
 * The execution-batch canonical encoding is intentionally owned by the
 * execution-ledger module; the on-chain program treats this value as opaque.
 */
export function receiptExecutionHash(value: Uint8Array): Buffer {
  return nonZeroBytes32(value, "executionBatchHash");
}

