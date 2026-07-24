import { createHash } from "node:crypto";

import { PublicKey } from "@solana/web3.js";

import { encodeI64LE, encodeU8, encodeU32LE, encodeU64LE } from "../contract/index.js";
import type { FakOrderResult } from "./types.js";

const EXECUTION_ATTESTATION_DOMAIN = Buffer.from("ALPHABASKET_EXECUTION_V1", "ascii");

function encodeText(value: string, name: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length === 0 || bytes.length > 1_024) {
    throw new RangeError(`${name} must encode to 1..1024 bytes`);
  }
  return Buffer.concat([encodeU32LE(bytes.length, `${name}.length`), bytes]);
}

function hex32(value: string, name: string): Buffer {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${name} must be lowercase hex32`);
  const bytes = Buffer.from(value, "hex");
  if (bytes.equals(Buffer.alloc(32))) throw new TypeError(`${name} must be non-zero`);
  return bytes;
}

export interface ExecutionAttestationInput {
  readonly kind: "deposit" | "withdrawal" | "protocol_fee_withdrawal";
  readonly operationId: string;
  readonly basket: string;
  readonly navReportHash: string;
  readonly settlementNonce: bigint;
  readonly executedAtSeconds: bigint;
  readonly bridgeSourceTxHash?: string;
  readonly bridgeDestinationTxHash?: string;
  readonly idlePusdUnits: bigint;
  readonly orders: readonly FakOrderResult[];
}

/** Versioned, length-prefixed execution record committed by the on-chain receipt hash. */
export function executionAttestationBytes(input: ExecutionAttestationInput): Buffer {
  const kind = input.kind === "deposit" ? 0 : input.kind === "withdrawal" ? 1 : 2;
  const basket = new PublicKey(input.basket);
  const ordered = [...input.orders].sort((left, right) =>
    left.clientOrderId.localeCompare(right.clientOrderId, "en"),
  );
  if (ordered.length > 64) throw new RangeError("execution attestation cannot exceed 64 orders");
  const encodedOrders = ordered.map((order, index) =>
    Buffer.concat([
      encodeText(order.clientOrderId, `orders[${index}].clientOrderId`),
      encodeText(order.orderId, `orders[${index}].orderId`),
      encodeText(order.tokenId, `orders[${index}].tokenId`),
      encodeU8(order.side === "buy" ? 0 : 1, `orders[${index}].side`),
      encodeU64LE(order.requestedAmountUnits, `orders[${index}].requested`),
      encodeU64LE(order.filledInputUnits, `orders[${index}].input`),
      encodeU64LE(order.filledOutputUnits, `orders[${index}].output`),
      encodeU64LE(order.averagePriceUnits ?? 0n, `orders[${index}].averagePrice`),
      encodeI64LE(order.executedAtMs / 1_000n, `orders[${index}].executedAt`),
    ]),
  );
  return Buffer.concat([
    EXECUTION_ATTESTATION_DOMAIN,
    encodeU8(kind, "kind"),
    encodeText(input.operationId, "operationId"),
    basket.toBuffer(),
    hex32(input.navReportHash, "navReportHash"),
    encodeU64LE(input.settlementNonce, "settlementNonce"),
    encodeI64LE(input.executedAtSeconds, "executedAtSeconds"),
    encodeText(input.bridgeSourceTxHash ?? "none", "bridgeSourceTxHash"),
    encodeText(input.bridgeDestinationTxHash ?? "none", "bridgeDestinationTxHash"),
    encodeU64LE(input.idlePusdUnits, "idlePusdUnits"),
    encodeU32LE(encodedOrders.length, "orderCount"),
    ...encodedOrders,
  ]);
}

export function executionBatchHash(input: ExecutionAttestationInput): Buffer {
  return createHash("sha256").update(executionAttestationBytes(input)).digest();
}

export function executionRequestHash(value: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"));
  const normalized = entries.map(([key, child]) => {
    if (typeof child === "bigint") return [key, ["bigint", child.toString(10)]];
    if (typeof child === "string" || typeof child === "boolean" || child === null) return [key, child];
    throw new TypeError(`execution request field ${key} has unsupported type`);
  });
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}
