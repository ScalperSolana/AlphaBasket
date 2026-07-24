import { compareCodeUnits } from "./filters.js";

export const TOTAL_WEIGHT_BPS = 10_000;
export const MAX_SINGLE_MARKET_WEIGHT_BPS = 4_000;

export interface ScoreInput {
  readonly key: string;
  readonly score: bigint;
}

export interface WeightAllocation {
  readonly key: string;
  readonly weightBps: number;
}

export interface GroupedScoreInput extends ScoreInput {
  readonly groupKey: string;
}

export const integerSqrt = (value: bigint): bigint => {
  if (value < 0n) {
    throw new RangeError("integerSqrt requires a non-negative value");
  }
  if (value < 2n) {
    return value;
  }
  let estimate = 1n << (BigInt(value.toString(2).length) + 1n >> 1n);
  while (true) {
    const next = (estimate + value / estimate) >> 1n;
    if (next >= estimate) {
      return estimate;
    }
    estimate = next;
  }
};

export const liquidityVolumeScore = (depthUnits: bigint, volume24hUnits: bigint): bigint => {
  if (depthUnits < 0n || volume24hUnits < 0n) {
    throw new RangeError("depth and volume must be non-negative");
  }
  return integerSqrt(depthUnits * volume24hUnits);
};

interface RemainingScore extends ScoreInput {
  readonly index: number;
}

/**
 * Deterministic integer water-filling. Oversized markets are capped iteratively;
 * uncapped remainders are assigned by largest rational remainder then byte order.
 */
export const allocateCappedWeights = (
  inputs: readonly ScoreInput[],
  maxWeightBps = MAX_SINGLE_MARKET_WEIGHT_BPS,
): readonly WeightAllocation[] => {
  if (!Number.isSafeInteger(maxWeightBps) || maxWeightBps <= 0 || maxWeightBps > TOTAL_WEIGHT_BPS) {
    throw new RangeError("maxWeightBps must be an integer in (0, 10000]");
  }
  if (inputs.length === 0 || inputs.length * maxWeightBps < TOTAL_WEIGHT_BPS) {
    throw new RangeError("not enough markets to satisfy the single-market cap");
  }
  const ordered = [...inputs].sort((left, right) => compareCodeUnits(left.key, right.key));
  const keys = new Set<string>();
  ordered.forEach((input) => {
    if (input.key.length === 0 || input.score <= 0n) {
      throw new RangeError("weight keys must be non-empty and scores must be positive");
    }
    if (keys.has(input.key)) {
      throw new Error(`Duplicate weight key ${input.key}`);
    }
    keys.add(input.key);
  });

  // Reserve one basis point for every selected item. The contract rejects zero
  // weights, and extreme score ratios must not silently produce a 0-bps item.
  const weights = new Array<number>(ordered.length).fill(1);
  let remaining: RemainingScore[] = ordered.map((input, index) => ({ ...input, index }));
  let remainingBps = TOTAL_WEIGHT_BPS - ordered.length;
  const remainingCapacityPerItem = maxWeightBps - 1;

  while (true) {
    const scoreTotal = remaining.reduce((sum, item) => sum + item.score, 0n);
    if (scoreTotal <= 0n) {
      throw new Error("remaining composer score unexpectedly became zero");
    }
    const overCap = remaining.filter(
      (item) =>
        item.score * BigInt(remainingBps) >
        BigInt(remainingCapacityPerItem) * scoreTotal,
    );
    if (overCap.length === 0) {
      break;
    }
    const capped = new Set(overCap.map((item) => item.index));
    for (const item of overCap) {
      weights[item.index] = maxWeightBps;
      remainingBps -= remainingCapacityPerItem;
    }
    remaining = remaining.filter((item) => !capped.has(item.index));
    if (remaining.length === 0 || remainingBps < 0) {
      throw new Error("single-market cap allocation is infeasible");
    }
  }

  const scoreTotal = remaining.reduce((sum, item) => sum + item.score, 0n);
  const remainders: Array<{ readonly item: RemainingScore; readonly remainder: bigint }> = [];
  let floors = 0;
  for (const item of remaining) {
    const numerator = item.score * BigInt(remainingBps);
    const floor = Number(numerator / scoreTotal);
    if (!Number.isSafeInteger(floor) || floor < 0 || floor > maxWeightBps) {
      throw new Error("computed composer weight is outside its integer bounds");
    }
    weights[item.index] = 1 + floor;
    floors += floor;
    remainders.push({ item, remainder: numerator % scoreTotal });
  }
  let dust = remainingBps - floors;
  remainders.sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1;
    }
    return compareCodeUnits(left.item.key, right.item.key);
  });
  for (const entry of remainders) {
    if (dust === 0) break;
    const current = weights[entry.item.index];
    if (current === undefined) {
      throw new Error("missing intermediate composer weight");
    }
    if (current < maxWeightBps) {
      weights[entry.item.index] = current + 1;
      dust -= 1;
    }
  }
  if (dust !== 0 || weights.reduce((sum, weight) => sum + weight, 0) !== TOTAL_WEIGHT_BPS) {
    throw new Error("failed to allocate exactly 10,000 basis points");
  }

  return Object.freeze(
    ordered.map((input, index) =>
      Object.freeze({ key: input.key, weightBps: weights[index] ?? 0 }),
    ),
  );
};

const allocatePositiveBudget = (
  inputs: readonly ScoreInput[],
  totalBps: number,
): readonly WeightAllocation[] => {
  if (inputs.length === 0 || totalBps < inputs.length) {
    throw new RangeError("group budget cannot assign a positive weight to every market");
  }
  const ordered = [...inputs].sort((left, right) => compareCodeUnits(left.key, right.key));
  const scoreTotal = ordered.reduce((sum, item) => sum + item.score, 0n);
  const distributable = totalBps - ordered.length;
  const rows = ordered.map((item) => {
    const numerator = item.score * BigInt(distributable);
    return { item, weightBps: 1 + Number(numerator / scoreTotal), remainder: numerator % scoreTotal };
  });
  let dust = totalBps - rows.reduce((sum, row) => sum + row.weightBps, 0);
  rows.sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return compareCodeUnits(left.item.key, right.item.key);
  });
  for (const row of rows) {
    if (dust === 0) break;
    row.weightBps += 1;
    dust -= 1;
  }
  if (dust !== 0) throw new Error("failed to distribute grouped composer weight dust");
  return Object.freeze(
    rows
      .map((row) => Object.freeze({ key: row.item.key, weightBps: row.weightBps }))
      .sort((left, right) => compareCodeUnits(left.key, right.key)),
  );
};

const allocateGroupBudgets = (
  groups: readonly {
    readonly key: string;
    readonly score: bigint;
    readonly minimum: number;
  }[],
): readonly WeightAllocation[] => {
  if (
    groups.length === 0 ||
    groups.length * MAX_SINGLE_MARKET_WEIGHT_BPS < TOTAL_WEIGHT_BPS
  ) {
    throw new RangeError("not enough events to satisfy the event cap");
  }
  const ordered = [...groups].sort((left, right) =>
    compareCodeUnits(left.key, right.key),
  );
  const weights = ordered.map((group) => group.minimum);
  let remainingBps =
    TOTAL_WEIGHT_BPS - weights.reduce((sum, weight) => sum + weight, 0);
  if (remainingBps < 0) {
    throw new RangeError("more selected markets than available basis points");
  }
  let active = ordered.map((group, index) => ({
    ...group,
    index,
    capacity: MAX_SINGLE_MARKET_WEIGHT_BPS - group.minimum,
  }));
  if (active.some((group) => group.minimum <= 0 || group.capacity < 0)) {
    throw new RangeError("event minimum exceeds its 4,000 bps cap");
  }

  while (remainingBps > 0 && active.length > 0) {
    const scoreTotal = active.reduce((sum, group) => sum + group.score, 0n);
    const capped = active.filter(
      (group) =>
        group.score * BigInt(remainingBps) >
        BigInt(group.capacity) * scoreTotal,
    );
    if (capped.length === 0) break;
    const cappedIndexes = new Set(capped.map((group) => group.index));
    for (const group of capped) {
      weights[group.index] = MAX_SINGLE_MARKET_WEIGHT_BPS;
      remainingBps -= group.capacity;
    }
    active = active.filter((group) => !cappedIndexes.has(group.index));
  }

  if (remainingBps > 0) {
    const scoreTotal = active.reduce((sum, group) => sum + group.score, 0n);
    const remainders = active.map((group) => {
      const numerator = group.score * BigInt(remainingBps);
      const extra = Number(numerator / scoreTotal);
      weights[group.index] = (weights[group.index] ?? 0) + extra;
      return { group, extra, remainder: numerator % scoreTotal };
    });
    let dust =
      remainingBps - remainders.reduce((sum, row) => sum + row.extra, 0);
    remainders.sort((left, right) => {
      if (left.remainder !== right.remainder) {
        return left.remainder > right.remainder ? -1 : 1;
      }
      return compareCodeUnits(left.group.key, right.group.key);
    });
    for (const row of remainders) {
      if (dust === 0) break;
      const current = weights[row.group.index] ?? 0;
      if (current < MAX_SINGLE_MARKET_WEIGHT_BPS) {
        weights[row.group.index] = current + 1;
        dust -= 1;
      }
    }
    if (dust !== 0) throw new Error("failed to allocate event-budget dust");
  }

  if (
    weights.reduce((sum, weight) => sum + weight, 0) !== TOTAL_WEIGHT_BPS ||
    weights.some((weight) => weight <= 0 || weight > MAX_SINGLE_MARKET_WEIGHT_BPS)
  ) {
    throw new Error("invalid aggregate event budget allocation");
  }
  return Object.freeze(
    ordered.map((group, index) =>
      Object.freeze({ key: group.key, weightBps: weights[index] ?? 0 }),
    ),
  );
};

/** Caps the aggregate of every Gamma event, then distributes its budget across markets. */
export const allocateEventCappedWeights = (
  inputs: readonly GroupedScoreInput[],
): readonly WeightAllocation[] => {
  const groups = new Map<string, ScoreInput[]>();
  const keys = new Set<string>();
  for (const input of inputs) {
    if (input.groupKey.length === 0 || keys.has(input.key)) {
      throw new Error("group keys must be non-empty and market keys unique");
    }
    if (input.score <= 0n) throw new RangeError("composer scores must be positive");
    keys.add(input.key);
    const group = groups.get(input.groupKey) ?? [];
    group.push({ key: input.key, score: input.score });
    groups.set(input.groupKey, group);
  }
  const groupBudgets = allocateGroupBudgets(
    [...groups.entries()].map(([key, members]) => ({
      key,
      score: members.reduce((sum, member) => sum + member.score, 0n),
      minimum: members.length,
    })),
  );
  const allocations: WeightAllocation[] = [];
  for (const budget of groupBudgets) {
    const members = groups.get(budget.key);
    if (members === undefined) throw new Error("missing composer event group");
    allocations.push(...allocatePositiveBudget(members, budget.weightBps));
  }
  allocations.sort((left, right) => compareCodeUnits(left.key, right.key));
  if (allocations.reduce((sum, item) => sum + item.weightBps, 0) !== TOTAL_WEIGHT_BPS) {
    throw new Error("event-capped weights must total exactly 10,000 bps");
  }
  return Object.freeze(allocations.map((item) => Object.freeze(item)));
};
