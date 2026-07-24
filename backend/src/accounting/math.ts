import {
  DEPOSIT_FEE_BPS,
  EARLY_WITHDRAWAL_FEE_BPS,
  MANAGEMENT_FEE_BPS,
  MANAGEMENT_FEE_PERIOD_SECS,
  MATURE_HOLDING_PERIOD_SECS,
  MATURE_WITHDRAWAL_FEE_BPS,
  MAX_BPS,
  MAX_CREATOR_PERFORMANCE_FEE_BPS,
  MAX_MANAGEMENT_FEE_PERIODS,
  SHARE_SCALE,
} from "./constants.js";
import {
  addU128,
  addU64,
  basisPoints,
  i64,
  multiplyU128,
  subU64,
  subtractI64,
  u128,
  u64,
} from "./integers.js";

const MAX_BPS_BIGINT = BigInt(MAX_BPS);

/** Protocol fees round up, matching Rust `fee_ceil`. */
export function feeCeil(amount: bigint, feeBps: number): bigint {
  const checkedAmount = u64(amount, "amount");
  const checkedBps = basisPoints(feeBps, "feeBps");
  const product = multiplyU128(checkedAmount, checkedBps, "fee numerator");
  const numerator = addU128(
    product,
    MAX_BPS_BIGINT - 1n,
    "fee numerator",
  );
  return u64(numerator / MAX_BPS_BIGINT, "fee");
}

/** Performance fees round down, matching Rust `fee_floor`. */
export function feeFloor(amount: bigint, feeBps: number): bigint {
  const checkedAmount = u64(amount, "amount");
  const checkedBps = basisPoints(feeBps, "feeBps");
  const numerator = multiplyU128(
    checkedAmount,
    checkedBps,
    "fee numerator",
  );
  return u64(numerator / MAX_BPS_BIGINT, "fee");
}

/** Deposit share issuance rounds down in the protocol's favour. */
export function sharesForValue(netValue: bigint, sharePrice: bigint): bigint {
  const checkedNet = u64(netValue, "netValue");
  const checkedPrice = u64(sharePrice, "sharePrice");
  if (checkedPrice === 0n) {
    throw new RangeError("sharePrice must be positive");
  }
  const numerator = multiplyU128(
    checkedNet,
    SHARE_SCALE,
    "share numerator",
  );
  return u64(numerator / checkedPrice, "shares");
}

/** Current share price rounds down to six accounting decimals. */
export function sharePriceFromNav(
  navValue: bigint,
  totalShares: bigint,
): bigint {
  const checkedNav = u64(navValue, "navValue");
  const checkedShares = u64(totalShares, "totalShares");
  if (checkedShares === 0n) {
    throw new RangeError("totalShares must be positive");
  }
  const numerator = multiplyU128(
    checkedNav,
    SHARE_SCALE,
    "share-price numerator",
  );
  return u64(numerator / checkedShares, "sharePrice");
}

/** Gross value represented by shares rounds down. */
export function valueForShares(
  shares: bigint,
  sharePrice: bigint,
): bigint {
  const numerator = multiplyU128(
    u64(shares, "shares"),
    u64(sharePrice, "sharePrice"),
    "share-value numerator",
  );
  return u64(numerator / SHARE_SCALE, "shareValue");
}

/** Exact pro-rata final value; rounds down like the on-chain implementation. */
export function proRataValue(
  totalValue: bigint,
  shares: bigint,
  totalShares: bigint,
): bigint {
  const checkedTotalShares = u64(totalShares, "totalShares");
  if (checkedTotalShares === 0n) {
    throw new RangeError("totalShares must be positive");
  }
  const numerator = multiplyU128(
    u64(totalValue, "totalValue"),
    u64(shares, "shares"),
    "pro-rata numerator",
  );
  return u64(numerator / checkedTotalShares, "proRataValue");
}

/**
 * Allocates basis to redeemed shares. A partial redemption rounds basis up in
 * the user's favour; a full redemption consumes the exact remaining basis.
 */
export function costBasisForShares(
  costBasis: bigint,
  sharesRedeemed: bigint,
  sharesOwned: bigint,
): bigint {
  const checkedBasis = u64(costBasis, "costBasis");
  const checkedRedeemed = u64(sharesRedeemed, "sharesRedeemed");
  const checkedOwned = u64(sharesOwned, "sharesOwned");
  if (checkedOwned === 0n || checkedRedeemed > checkedOwned) {
    throw new RangeError("sharesRedeemed must not exceed positive sharesOwned");
  }
  if (checkedRedeemed === checkedOwned) {
    return checkedBasis;
  }
  const product = multiplyU128(
    checkedBasis,
    checkedRedeemed,
    "cost-basis numerator",
  );
  const numerator = addU128(
    product,
    checkedOwned - 1n,
    "cost-basis numerator",
  );
  return u64(numerator / checkedOwned, "withdrawnCostBasis");
}

/** Protocol slippage floor rounds up so tolerance is never exceeded by dust. */
export function minimumAfterSlippage(
  quotedOut: bigint,
  toleranceBps: number,
): bigint {
  const checkedOut = u64(quotedOut, "quotedOut");
  const tolerance = basisPoints(toleranceBps, "toleranceBps");
  const retained = MAX_BPS_BIGINT - tolerance;
  const product = multiplyU128(
    checkedOut,
    retained,
    "slippage numerator",
  );
  const numerator = addU128(
    product,
    MAX_BPS_BIGINT - 1n,
    "slippage numerator",
  );
  return u64(numerator / MAX_BPS_BIGINT, "minimumOutput");
}

/** One full 30-day management-fee period, retained for parity with Rust. */
export function managementFeeShares(totalShares: bigint): bigint {
  const denominator = MAX_BPS_BIGINT - BigInt(MANAGEMENT_FEE_BPS);
  const numerator = multiplyU128(
    u64(totalShares, "totalShares"),
    BigInt(MANAGEMENT_FEE_BPS),
    "management-fee numerator",
  );
  return u64(numerator / denominator, "managementFeeShares");
}

export interface ManagementFeeIntervalResult {
  readonly minted: bigint;
  readonly remainder: bigint;
}

/** Exact time-weighted dilution for one interval. */
export function managementFeeSharesForElapsed(
  totalShares: bigint,
  elapsedSeconds: bigint,
  priorRemainder: bigint,
): ManagementFeeIntervalResult {
  const checkedTotal = u64(totalShares, "totalShares");
  const checkedElapsed = i64(elapsedSeconds, "elapsedSeconds");
  if (checkedElapsed < 0n) {
    throw new RangeError("elapsedSeconds cannot be negative");
  }
  const checkedRemainder = u128(priorRemainder, "priorRemainder");
  const dilutionDenominator = multiplyU128(
    MAX_BPS_BIGINT - BigInt(MANAGEMENT_FEE_BPS),
    MANAGEMENT_FEE_PERIOD_SECS,
    "management-fee denominator",
  );
  if (checkedRemainder >= dilutionDenominator) {
    throw new RangeError("priorRemainder exceeds the dilution denominator");
  }

  let numerator = multiplyU128(
    checkedTotal,
    BigInt(MANAGEMENT_FEE_BPS),
    "management-fee numerator",
  );
  numerator = multiplyU128(
    numerator,
    checkedElapsed,
    "management-fee numerator",
  );
  numerator = addU128(
    numerator,
    checkedRemainder,
    "management-fee numerator",
  );
  return {
    minted: u64(numerator / dilutionDenominator, "managementFeeShares"),
    remainder: numerator % dilutionDenominator,
  };
}

export interface ManagementFeeState {
  readonly totalSharesOutstanding: bigint;
  readonly protocolFeeShares: bigint;
  readonly lastManagementFeeAt: bigint;
  readonly managementFeeAccrualRemainder: bigint;
}

export interface ManagementFeeAccrualResult extends ManagementFeeState {
  readonly mintedShares: bigint;
  readonly elapsedSeconds: bigint;
  readonly completePeriods: bigint;
}

/**
 * Mirrors `accrue_management_fee_internal`, including 30-day chunking,
 * compounding, exact-second accrual and sub-share remainder carry.
 */
export function accrueManagementFee(
  state: ManagementFeeState,
  now: bigint,
): ManagementFeeAccrualResult {
  let totalShares = u64(
    state.totalSharesOutstanding,
    "totalSharesOutstanding",
  );
  let protocolShares = u64(
    state.protocolFeeShares,
    "protocolFeeShares",
  );
  const checkedNow = i64(now, "now");
  const lastAccrual = i64(
    state.lastManagementFeeAt,
    "lastManagementFeeAt",
  );
  let remainder = u128(
    state.managementFeeAccrualRemainder,
    "managementFeeAccrualRemainder",
  );
  const userShares = subU64(
    totalShares,
    protocolShares,
    "user share balance",
  );

  if (totalShares === 0n || userShares === 0n || lastAccrual === 0n) {
    return {
      totalSharesOutstanding: totalShares,
      protocolFeeShares: protocolShares,
      lastManagementFeeAt: checkedNow,
      managementFeeAccrualRemainder: 0n,
      mintedShares: 0n,
      elapsedSeconds: 0n,
      completePeriods: 0n,
    };
  }

  const elapsed = subtractI64(checkedNow, lastAccrual, "elapsed seconds");
  if (elapsed < 0n) {
    throw new RangeError("now cannot precede lastManagementFeeAt");
  }
  if (elapsed === 0n) {
    return {
      totalSharesOutstanding: totalShares,
      protocolFeeShares: protocolShares,
      lastManagementFeeAt: lastAccrual,
      managementFeeAccrualRemainder: remainder,
      mintedShares: 0n,
      elapsedSeconds: 0n,
      completePeriods: 0n,
    };
  }

  const periods = elapsed / MANAGEMENT_FEE_PERIOD_SECS;
  if (periods > MAX_MANAGEMENT_FEE_PERIODS) {
    throw new RangeError("management-fee catch-up exceeds 600 periods");
  }

  let totalMinted = 0n;
  let remaining = elapsed;
  while (remaining > 0n) {
    const interval =
      remaining < MANAGEMENT_FEE_PERIOD_SECS
        ? remaining
        : MANAGEMENT_FEE_PERIOD_SECS;
    const result = managementFeeSharesForElapsed(
      totalShares,
      interval,
      remainder,
    );
    remainder = result.remainder;
    totalShares = addU64(
      totalShares,
      result.minted,
      "totalSharesOutstanding",
    );
    protocolShares = addU64(
      protocolShares,
      result.minted,
      "protocolFeeShares",
    );
    totalMinted = addU64(totalMinted, result.minted, "mintedShares");
    remaining -= interval;
  }

  return {
    totalSharesOutstanding: totalShares,
    protocolFeeShares: protocolShares,
    lastManagementFeeAt: checkedNow,
    managementFeeAccrualRemainder: remainder,
    mintedShares: totalMinted,
    elapsedSeconds: elapsed,
    completePeriods: periods,
  };
}

/** Cost-basis-weighted holding timestamp used by the contract. */
export function weightedAverageTimestamp(
  existingCostBasis: bigint,
  existingTimestamp: bigint,
  addedCostBasis: bigint,
  now: bigint,
): bigint {
  const existingBasis = u64(existingCostBasis, "existingCostBasis");
  const addedBasis = u64(addedCostBasis, "addedCostBasis");
  const checkedExistingTimestamp = i64(
    existingTimestamp,
    "existingTimestamp",
  );
  const checkedNow = i64(now, "now");
  if (addedBasis === 0n || checkedNow <= 0n) {
    throw new RangeError("addedCostBasis and now must be positive");
  }
  if (existingBasis === 0n) {
    return checkedNow;
  }
  if (
    checkedExistingTimestamp <= 0n ||
    checkedExistingTimestamp > checkedNow
  ) {
    throw new RangeError("existingTimestamp is invalid");
  }

  const totalBasis = addU64(existingBasis, addedBasis, "totalCostBasis");
  const existingWeighted = multiplyU128(
    checkedExistingTimestamp,
    existingBasis,
    "weighted timestamp numerator",
  );
  const addedWeighted = multiplyU128(
    checkedNow,
    addedBasis,
    "weighted timestamp numerator",
  );
  const numerator = addU128(
    existingWeighted,
    addedWeighted,
    "weighted timestamp numerator",
  );
  return i64(numerator / totalBasis, "weightedDepositTimestamp");
}

export interface WithdrawalBreakdown {
  readonly costBasis: bigint;
  readonly realizedProfit: bigint;
  readonly earlyExitValue: bigint;
  readonly matureExitValue: bigint;
}

export function weightedAverageWithdrawalBreakdown(
  costBasisValue: bigint,
  sharesOwned: bigint,
  weightedDepositTimestamp: bigint,
  sharesToConsume: bigint,
  grossValue: bigint,
  now: bigint,
): WithdrawalBreakdown {
  const timestamp = i64(
    weightedDepositTimestamp,
    "weightedDepositTimestamp",
  );
  const checkedNow = i64(now, "now");
  if (timestamp <= 0n || timestamp > checkedNow) {
    throw new RangeError("weightedDepositTimestamp is invalid");
  }
  const costBasis = costBasisForShares(
    costBasisValue,
    sharesToConsume,
    sharesOwned,
  );
  const checkedGross = u64(grossValue, "grossValue");
  const age = subtractI64(checkedNow, timestamp, "holding age");
  const mature = age >= MATURE_HOLDING_PERIOD_SECS;
  return {
    costBasis,
    realizedProfit:
      checkedGross > costBasis ? checkedGross - costBasis : 0n,
    earlyExitValue: mature ? 0n : checkedGross,
    matureExitValue: mature ? checkedGross : 0n,
  };
}

export interface DepositSettlementMath {
  readonly protocolFee: bigint;
  readonly quotedNetValue: bigint;
  readonly minimumNetValue: bigint;
  readonly sharesCredited: bigint;
}

export function calculateDepositSettlement(
  grossAmount: bigint,
  actualNetValue: bigint,
  sharePrice: bigint,
  maxSlippageBps: number,
): DepositSettlementMath {
  const protocolFee = feeCeil(grossAmount, DEPOSIT_FEE_BPS);
  const quotedNetValue = subU64(
    grossAmount,
    protocolFee,
    "quotedNetValue",
  );
  const checkedActual = u64(actualNetValue, "actualNetValue");
  const minimumNetValue = minimumAfterSlippage(
    quotedNetValue,
    maxSlippageBps,
  );
  if (checkedActual > quotedNetValue || checkedActual < minimumNetValue) {
    throw new RangeError("actualNetValue is outside the allowed range");
  }
  const sharesCredited = sharesForValue(checkedActual, sharePrice);
  if (sharesCredited === 0n) {
    throw new RangeError("deposit would credit zero shares");
  }
  return {
    protocolFee,
    quotedNetValue,
    minimumNetValue,
    sharesCredited,
  };
}

export interface WithdrawalSettlementMath extends WithdrawalBreakdown {
  readonly creatorFee: bigint;
  readonly protocolFee: bigint;
  readonly userValueOut: bigint;
}

export function calculateWithdrawalSettlement(
  costBasisValue: bigint,
  sharesOwned: bigint,
  weightedDepositTimestamp: bigint,
  sharesToConsume: bigint,
  grossValue: bigint,
  now: bigint,
  performanceFeeBps: number,
): WithdrawalSettlementMath {
  if (
    !Number.isInteger(performanceFeeBps) ||
    performanceFeeBps < 0 ||
    performanceFeeBps > MAX_CREATOR_PERFORMANCE_FEE_BPS
  ) {
    throw new RangeError(
      `performanceFeeBps must be in [0, ${MAX_CREATOR_PERFORMANCE_FEE_BPS}]`,
    );
  }
  const breakdown = weightedAverageWithdrawalBreakdown(
    costBasisValue,
    sharesOwned,
    weightedDepositTimestamp,
    sharesToConsume,
    grossValue,
    now,
  );
  const creatorFee = feeFloor(
    breakdown.realizedProfit,
    performanceFeeBps,
  );
  const earlyFee = feeCeil(
    breakdown.earlyExitValue,
    EARLY_WITHDRAWAL_FEE_BPS,
  );
  const matureFee = feeCeil(
    breakdown.matureExitValue,
    MATURE_WITHDRAWAL_FEE_BPS,
  );
  const protocolFee = addU64(earlyFee, matureFee, "protocolFee");
  const afterProtocol = subU64(grossValue, protocolFee, "userValueOut");
  const userValueOut = subU64(afterProtocol, creatorFee, "userValueOut");
  return { ...breakdown, creatorFee, protocolFee, userValueOut };
}
