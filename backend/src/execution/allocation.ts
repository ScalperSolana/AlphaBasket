import { u64 } from "../accounting/integers.js";

export interface WeightedExecutionTarget {
  readonly tokenId: string;
  readonly weightBps: number;
  readonly currentUnits?: bigint;
}

export interface AllocatedExecutionTarget extends WeightedExecutionTarget {
  readonly amountUnits: bigint;
}

function validateTargets(targets: readonly WeightedExecutionTarget[]): void {
  if (targets.length === 0 || targets.length > 16) throw new RangeError("targets must contain 1..16 items");
  const seen = new Set<string>();
  let total = 0;
  for (const target of targets) {
    if (target.tokenId.length === 0 || seen.has(target.tokenId)) throw new TypeError("target token IDs must be non-empty and unique");
    if (!Number.isInteger(target.weightBps) || target.weightBps <= 0 || target.weightBps > 4_000) {
      throw new RangeError("target weights must be integer bps in 1..4000");
    }
    seen.add(target.tokenId);
    total += target.weightBps;
  }
  if (total !== 10_000) throw new RangeError("target weights must total 10,000 bps");
}

/** Allocates pUSD by weight; all division dust remains idle pUSD. */
export function allocateDepositPusd(
  pusdUnits: bigint,
  targets: readonly WeightedExecutionTarget[],
): { readonly targets: readonly AllocatedExecutionTarget[]; readonly idlePusdUnits: bigint } {
  const total = u64(pusdUnits, "pusdUnits");
  validateTargets(targets);
  let allocated = 0n;
  const result = targets.map((target) => {
    const amountUnits = (total * BigInt(target.weightBps)) / 10_000n;
    allocated += amountUnits;
    return Object.freeze({ ...target, amountUnits });
  });
  return Object.freeze({ targets: Object.freeze(result), idlePusdUnits: total - allocated });
}

/** Proportional sell sizing; token dust remains attributed to the basket. */
export function allocateProportionalLiquidation(
  sharesRedeemed: bigint,
  totalShares: bigint,
  targets: readonly WeightedExecutionTarget[],
): readonly AllocatedExecutionTarget[] {
  const redeemed = u64(sharesRedeemed, "sharesRedeemed");
  const supply = u64(totalShares, "totalShares");
  if (supply === 0n || redeemed === 0n || redeemed > supply) {
    throw new RangeError("sharesRedeemed must be within positive totalShares");
  }
  validateTargets(targets);
  return Object.freeze(targets.map((target) => {
    const current = u64(target.currentUnits ?? 0n, "currentUnits");
    return Object.freeze({ ...target, amountUnits: (current * redeemed) / supply });
  }));
}
