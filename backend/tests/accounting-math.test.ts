import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MANAGEMENT_FEE_PERIOD_SECS,
  MATURE_HOLDING_PERIOD_SECS,
  U64_MAX,
  accrueManagementFee,
  calculateDepositSettlement,
  calculateWithdrawalSettlement,
  costBasisForShares,
  feeCeil,
  feeFloor,
  managementFeeShares,
  managementFeeSharesForElapsed,
  minimumAfterSlippage,
  proRataValue,
  sharePriceFromNav,
  sharesForValue,
  valueForShares,
  weightedAverageTimestamp,
  weightedAverageWithdrawalBreakdown,
} from "../src/accounting/index.js";

// Values below are the golden assertions from the Rust math tests plus
// multi-period vectors produced by the same u128/chunking algorithm.
describe("accounting arithmetic parity with Rust", () => {
  it("matches fee, share-price and value rounding", () => {
    assert.equal(feeCeil(100_000_000n, 50), 500_000n);
    assert.equal(feeCeil(1n, 50), 1n);
    assert.equal(feeFloor(20_000_000n, 1_000), 2_000_000n);
    assert.equal(sharesForValue(494_000_000n, 1_000_000n), 494_000_000n);
    assert.equal(sharesForValue(10n, 3_000_000n), 3n);
    assert.equal(
      sharePriceFromNav(1_990_000_000n, 995_000_000n),
      2_000_000n,
    );
    assert.equal(valueForShares(497_500_000n, 2_000_000n), 995_000_000n);
  });

  it("matches basis allocation, slippage and final pro-rata rounding", () => {
    assert.equal(costBasisForShares(100_000_001n, 50n, 100n), 50_000_001n);
    assert.equal(costBasisForShares(50_000_000n, 50n, 50n), 50_000_000n);
    assert.equal(minimumAfterSlippage(100_000_000n, 200), 98_000_000n);
    assert.equal(minimumAfterSlippage(101n, 100), 100n);
    assert.equal(minimumAfterSlippage(U64_MAX, 0), U64_MAX);
    assert.equal(minimumAfterSlippage(U64_MAX, 10_000), 0n);
    assert.equal(proRataValue(10n, 1n, 3n), 3n);
  });

  it("rejects unsafe JS numbers and Rust-equivalent invalid ranges", () => {
    assert.throws(
      () => feeCeil(1 as unknown as bigint, 50),
      /u64 bigint/,
    );
    assert.throws(() => sharesForValue(1n, 0n), /positive/);
    assert.throws(() => sharePriceFromNav(1n, 0n), /positive/);
    assert.throws(() => costBasisForShares(1n, 2n, 1n), /must not exceed/);
    assert.throws(() => minimumAfterSlippage(1n, 10_001), /10000/);
  });
});

describe("time-weighted management-fee parity", () => {
  it("matches the full-period and half-period Rust vectors", () => {
    assert.equal(managementFeeShares(25_000_000_000n), 87_807_325n);
    assert.deepEqual(
      managementFeeSharesForElapsed(
        25_000_000_000n,
        MANAGEMENT_FEE_PERIOD_SECS / 2n,
        0n,
      ),
      { minted: 43_903_662n, remainder: 21_176_640_000n },
    );
  });

  it("chunks and compounds a 45-day catch-up exactly", () => {
    const start = 1_700_000_000n;
    assert.deepEqual(
      accrueManagementFee(
        {
          totalSharesOutstanding: 25_000_000_000n,
          protocolFeeShares: 0n,
          lastManagementFeeAt: start,
          managementFeeAccrualRemainder: 0n,
        },
        start + 45n * 86_400n,
      ),
      {
        totalSharesOutstanding: 25_131_865_190n,
        protocolFeeShares: 131_865_190n,
        lastManagementFeeAt: start + 45n * 86_400n,
        managementFeeAccrualRemainder: 25_498_800_000n,
        mintedShares: 131_865_190n,
        elapsedSeconds: 45n * 86_400n,
        completePeriods: 1n,
      },
    );
  });

  it("initializes/reset timestamps and rejects excessive catch-up", () => {
    assert.equal(
      accrueManagementFee(
        {
          totalSharesOutstanding: 100n,
          protocolFeeShares: 0n,
          lastManagementFeeAt: 0n,
          managementFeeAccrualRemainder: 123n,
        },
        99n,
      ).managementFeeAccrualRemainder,
      0n,
    );
    assert.throws(
      () =>
        accrueManagementFee(
          {
            totalSharesOutstanding: 100n,
            protocolFeeShares: 0n,
            lastManagementFeeAt: 1n,
            managementFeeAccrualRemainder: 0n,
          },
          1n + 601n * MANAGEMENT_FEE_PERIOD_SECS,
        ),
      /600 periods/,
    );
    assert.throws(
      () =>
        accrueManagementFee(
          {
            totalSharesOutstanding: 100n,
            protocolFeeShares: 101n,
            lastManagementFeeAt: 1n,
            managementFeeAccrualRemainder: 0n,
          },
          2n,
        ),
      /underflow/,
    );
  });
});

describe("weighted entry and withdrawal settlement", () => {
  it("weights a later deposit timestamp by cost basis", () => {
    const start = 1_700_000_000n;
    assert.equal(
      weightedAverageTimestamp(
        100_000_000n,
        start,
        300_000_000n,
        start + 30n * 86_400n,
      ),
      1_701_944_000n,
    );
    assert.equal(weightedAverageTimestamp(0n, 0n, 10n, start), start);
  });

  it("matches the early profitable withdrawal fee vector", () => {
    const result = calculateWithdrawalSettlement(
      99_500_000n,
      99_500_000n,
      1_700_000_000n,
      99_500_000n,
      199_000_000n,
      1_700_000_100n,
      1_000,
    );
    assert.deepEqual(result, {
      costBasis: 99_500_000n,
      realizedProfit: 99_500_000n,
      earlyExitValue: 199_000_000n,
      matureExitValue: 0n,
      creatorFee: 9_950_000n,
      protocolFee: 3_980_000n,
      userValueOut: 185_070_000n,
    });
  });

  it("charges no performance fee at a loss and applies the mature tier", () => {
    const timestamp = 1_700_000_000n;
    const result = calculateWithdrawalSettlement(
      100_000_000n,
      100_000_000n,
      timestamp,
      50_000_000n,
      40_000_000n,
      timestamp + MATURE_HOLDING_PERIOD_SECS,
      1_000,
    );
    assert.deepEqual(result, {
      costBasis: 50_000_000n,
      realizedProfit: 0n,
      earlyExitValue: 0n,
      matureExitValue: 40_000_000n,
      creatorFee: 0n,
      protocolFee: 400_000n,
      userValueOut: 39_600_000n,
    });
  });

  it("computes bounded deposit settlement from actual credited value", () => {
    assert.deepEqual(
      calculateDepositSettlement(100_000_000n, 98_505_000n, 1_000_000n, 1_000),
      {
        protocolFee: 500_000n,
        quotedNetValue: 99_500_000n,
        minimumNetValue: 89_550_000n,
        sharesCredited: 98_505_000n,
      },
    );
    assert.throws(
      () => calculateDepositSettlement(100_000_000n, 100_000_000n, 1_000_000n, 1_000),
      /outside/,
    );
  });

  it("exposes the same weighted withdrawal components independently", () => {
    assert.deepEqual(
      weightedAverageWithdrawalBreakdown(
        100_000_001n,
        100n,
        100n,
        50n,
        50_000_000n,
        101n,
      ),
      {
        costBasis: 50_000_001n,
        realizedProfit: 0n,
        earlyExitValue: 50_000_000n,
        matureExitValue: 0n,
      },
    );
  });
});

