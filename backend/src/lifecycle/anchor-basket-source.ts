import type { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import type { PolybasketsEscrow } from "../contract/generated/polybaskets_escrow.js";
import type {
  BasketLifecycleStatus,
  LifecycleBasket,
  LifecycleBasketSourcePort,
} from "./types.js";

interface AnchorBasketRow {
  readonly publicKey: PublicKey;
  readonly account: Readonly<Record<string, unknown>>;
}

const integer = (value: unknown, name: string): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?(?:0|[1-9][0-9]*)$/u.test(value)) return BigInt(value);
  if (typeof value === "object" && value !== null && "toString" in value && typeof value.toString === "function") {
    const text = value.toString();
    if (/^-?(?:0|[1-9][0-9]*)$/u.test(text)) return BigInt(text);
  }
  throw new TypeError(`basket.${name} is not an integer`);
};

const bytes = (value: unknown, name: string): Uint8Array => {
  if (value instanceof Uint8Array && value.byteLength === 32) return Uint8Array.from(value);
  if (Array.isArray(value) && value.length === 32 && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(value as number[]);
  }
  throw new TypeError(`basket.${name} is not bytes32`);
};

const status = (value: unknown): BasketLifecycleStatus => {
  if (typeof value === "string" && ["active", "reconstituting", "resolving", "redeemable", "closed"].includes(value)) {
    return value as BasketLifecycleStatus;
  }
  if (typeof value === "object" && value !== null) {
    const key = Object.keys(value)[0];
    if (key !== undefined && ["active", "reconstituting", "resolving", "redeemable", "closed"].includes(key)) {
      return key as BasketLifecycleStatus;
    }
  }
  throw new TypeError("basket.status is invalid");
};

const mapBasket = (row: AnchorBasketRow): LifecycleBasket => {
  const account = row.account;
  if (typeof account.isPerpetual !== "boolean") throw new TypeError("basket.isPerpetual is invalid");
  const compositionVersion = integer(account.compositionVersion, "compositionVersion");
  if (compositionVersion <= 0n || compositionVersion > 0xffff_ffffn) throw new RangeError("basket.compositionVersion is invalid");
  return Object.freeze({
    address: row.publicKey,
    basketId: bytes(account.basketId, "basketId"),
    status: status(account.status),
    isPerpetual: account.isPerpetual,
    compositionVersion: Number(compositionVersion),
    lastCompositionNonce: integer(account.lastCompositionNonce, "lastCompositionNonce"),
    lastManagementFeeAtSeconds: integer(account.lastManagementFeeAt, "lastManagementFeeAt"),
    lastReconstitutionAtSeconds: integer(account.lastReconstitutionAt, "lastReconstitutionAt"),
    reconstitutionCadenceSeconds: integer(account.reconstitutionCadenceSecs, "reconstitutionCadenceSecs"),
    totalSharesOutstanding: integer(account.totalSharesOutstanding, "totalSharesOutstanding"),
  });
};

export class AnchorLifecycleBasketSource implements LifecycleBasketSourcePort {
  public constructor(private readonly program: Program<PolybasketsEscrow>) {}

  public async listBaskets(statuses: readonly BasketLifecycleStatus[], limit: number): Promise<readonly LifecycleBasket[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) throw new RangeError("basket limit must be between 1 and 10000");
    const rows = await this.program.account.basket.all() as unknown as readonly AnchorBasketRow[];
    const accepted = new Set(statuses);
    return Object.freeze(rows.map(mapBasket).filter((basket) => accepted.has(basket.status)).slice(0, limit));
  }

  public async loadBasket(address: PublicKey): Promise<LifecycleBasket> {
    const account = await this.program.account.basket.fetch(address) as unknown as Readonly<Record<string, unknown>>;
    return mapBasket({ publicKey: address, account });
  }
}
