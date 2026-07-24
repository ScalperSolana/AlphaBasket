import { keccak_256 } from "@noble/hashes/sha3.js";

import type { PolymarketPosition } from "./positions-rest.js";
import type { PolymarketRelayerTransaction } from "./relayer-rest.js";

export const POLYMARKET_PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
export const POLYMARKET_CTF_COLLATERAL_ADAPTER = "0xAdA100Db00Ca00073811820692005400218FcE1f";
export const POLYMARKET_NEG_RISK_CTF_COLLATERAL_ADAPTER = "0xadA2005600Dec949baf300f4C6120000bDB6eAab";

const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

function uint256Word(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) throw new RangeError("value is not uint256");
  return value.toString(16).padStart(64, "0");
}

function bytes32Word(value: string, name: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) throw new TypeError(`${name} must be bytes32`);
  return value.slice(2).toLowerCase();
}

function addressWord(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) throw new TypeError("collateral token must be an EVM address");
  return value.slice(2).toLowerCase().padStart(64, "0");
}

/** Exact ABI encoding of the documented pUSD collateral-adapter redemption call. */
export function redeemPositionsCalldata(
  conditionId: string,
  collateralToken = POLYMARKET_PUSD_ADDRESS,
): string {
  const signature = "redeemPositions(address,bytes32,bytes32,uint256[])";
  const selector = hex(keccak_256(Buffer.from(signature, "ascii"))).slice(0, 8);
  const parentCollectionId = "0".repeat(64);
  const arrayOffset = uint256Word(128n);
  const indexSets = [uint256Word(2n), uint256Word(1n), uint256Word(2n)].join("");
  return `0x${selector}${addressWord(collateralToken)}${parentCollectionId}${bytes32Word(conditionId, "conditionId")}${arrayOffset}${indexSets}`;
}

export function redemptionTransaction(conditionId: string, negativeRisk: boolean): PolymarketRelayerTransaction {
  return Object.freeze({
    to: negativeRisk ? POLYMARKET_NEG_RISK_CTF_COLLATERAL_ADAPTER : POLYMARKET_CTF_COLLATERAL_ADAPTER,
    data: redeemPositionsCalldata(conditionId),
    value: "0" as const,
  });
}

/** De-duplicates both YES/NO position rows into one redemption per condition. */
export function redemptionTransactions(positions: readonly PolymarketPosition[]): readonly PolymarketRelayerTransaction[] {
  const conditions = new Map<string, boolean>();
  for (const position of positions) {
    if (!position.redeemable || position.sizeUnits <= 0n) continue;
    const condition = position.conditionId.toLowerCase();
    const existing = conditions.get(condition);
    if (existing !== undefined && existing !== position.negativeRisk) {
      throw new Error(`condition ${condition} has conflicting negative-risk metadata`);
    }
    conditions.set(condition, position.negativeRisk);
  }
  return Object.freeze([...conditions.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([condition, negativeRisk]) => redemptionTransaction(condition, negativeRisk)));
}
