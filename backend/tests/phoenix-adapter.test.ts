import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PerpMarketSelector,
  SizingError,
  assessExecution,
  baseLotsToUnitsString,
  bps,
  collateralUnits,
  deviationBps,
  isolatedSubaccount,
  leverageBps,
  maxLeverageForSize,
  priceTicks,
  quoteLots,
  quoteLotsPerBaseLot,
  readVerifiedState,
  sideForTrade,
  sizeOpeningOrder,
  slot,
  baseLots as toBaseLots,
  ticksToQuoteLotsPerBaseLot,
  VerificationError,
  type MarketScale,
  type PhoenixExchangePort,
  type PhoenixMarket,
  type PhoenixTraderStatePort,
  type PhoenixTraderStateSnapshot,
  type VerifiedExecutionState,
} from "../src/phoenix/index.js";

/**
 * SOL's real parameters, captured from live Phoenix mainnet: tick size 100, two
 * base-lot decimals, 25x on the first leverage tier.
 */
const SOL: PhoenixMarket = {
  symbol: "SOL",
  assetId: 0,
  marketStatus: "active",
  tickSize: 100,
  baseLotsDecimals: 2,
  isolatedOnly: false,
  leverageTiers: [
    { maxSizeBaseLots: 32_164_684n, maxLeverage: 25 },
    { maxSizeBaseLots: 64_329_368n, maxLeverage: 10 },
  ],
};

const SCALE: MarketScale = {
  symbol: "SOL",
  tickSize: 100,
  baseLotsDecimals: 2,
};

/** $106.34, the price the live report showed. */
const MARK_TICKS = priceTicks(10_634n);
const MARK = ticksToQuoteLotsPerBaseLot(MARK_TICKS, SCALE);

describe("perpetual unit conversions", () => {
  it("converts ticks to quote lots per base lot", () => {
    assert.equal(MARK as bigint, 1_063_400n);
  });

  it("renders base lots as the decimal string Phoenix expects", () => {
    // A 2-decimal market: 31,357 lots is 313.57 tokens.
    assert.equal(baseLotsToUnitsString(31_357n, 2), "313.57");
    assert.equal(baseLotsToUnitsString(15n, 2), "0.15");
    assert.equal(baseLotsToUnitsString(100n, 2), "1");
    assert.equal(baseLotsToUnitsString(0n, 2), "0");
    assert.equal(baseLotsToUnitsString(-15n, 2), "-0.15");
    assert.equal(baseLotsToUnitsString(42n, 0), "42");
  });

  it("does not lose precision on a nine-decimal market", () => {
    // The reason this is integer string arithmetic rather than division.
    assert.equal(
      baseLotsToUnitsString(123_456_789_012_345_678n, 9),
      "123456789.012345678",
    );
  });

  it("reports deviation in basis points, and treats nothing-for-something as total", () => {
    assert.equal(deviationBps(1_000n, 1_000n), 0);
    assert.equal(deviationBps(1_000n, 950n), 500);
    assert.equal(deviationBps(0n, 0n), 0);
    assert.equal(deviationBps(1_000n, 0n), 10_000);
  });
});

describe("isolated subaccounts", () => {
  it("makes subaccount zero unrepresentable", () => {
    // Phoenix's subaccount 0 is the shared cross-margin account: a loss there
    // can consume collateral backing an unrelated position.
    assert.throws(() => isolatedSubaccount(0), /cross-margin/);
    assert.throws(() => isolatedSubaccount(-1), /\[1, 255\]/);
    assert.throws(() => isolatedSubaccount(256), /\[1, 255\]/);
    assert.throws(() => isolatedSubaccount(1.5), /\[1, 255\]/);
    assert.equal(isolatedSubaccount(1) as number, 1);
    assert.equal(isolatedSubaccount(255) as number, 255);
  });
});

describe("order side mapping", () => {
  it("maps an AlphaBasket intent onto a Phoenix orderbook side", () => {
    // Getting this backwards would double a position instead of closing it.
    assert.equal(sideForTrade("open", "long"), "bid");
    assert.equal(sideForTrade("close", "long"), "ask");
    assert.equal(sideForTrade("open", "short"), "ask");
    assert.equal(sideForTrade("close", "short"), "bid");
  });
});

describe("order sizing", () => {
  it("sizes from collateral, leverage and the live mark price", () => {
    // 9 USDC at 2x on a $106.34 mark is 0.16 SOL, which is 16 base lots.
    const sized = sizeOpeningOrder({
      market: SOL,
      markPrice: MARK,
      collateralUnits: collateralUnits(9_000_000n),
      leverageBps: leverageBps(20_000),
    });
    assert.equal(sized.baseLots as bigint, 16n);
    assert.equal(sized.maxLeverageAtSize, 25);
  });

  it("refuses rather than clamping when leverage exceeds the tier cap", () => {
    // Silently opening a smaller position would be a different trade than the
    // one the caller authorised, and they would have no way to know.
    assert.throws(
      () =>
        sizeOpeningOrder({
          market: SOL,
          markPrice: MARK,
          collateralUnits: collateralUnits(9_000_000n),
          leverageBps: leverageBps(300_000), // 30x, above the 25x tier
        }),
      SizingError,
    );
  });

  it("refuses a market it cannot price", () => {
    assert.throws(
      () =>
        sizeOpeningOrder({
          market: SOL,
          markPrice: quoteLotsPerBaseLot(0n),
          collateralUnits: collateralUnits(9_000_000n),
          leverageBps: leverageBps(20_000),
        }),
      /no usable mark price/,
    );
  });

  it("refuses a position smaller than one lot", () => {
    assert.throws(
      () =>
        sizeOpeningOrder({
          market: SOL,
          markPrice: MARK,
          collateralUnits: collateralUnits(1n),
          leverageBps: leverageBps(10_000),
        }),
      /smaller than one lot/,
    );
  });

  it("refuses leverage below 1x", () => {
    assert.throws(
      () =>
        sizeOpeningOrder({
          market: SOL,
          markPrice: MARK,
          collateralUnits: collateralUnits(9_000_000n),
          leverageBps: leverageBps(9_999),
        }),
      /at least 10000/,
    );
  });

  it("interpolates the leverage cap between tiers, and gives up past the last", () => {
    assert.equal(maxLeverageForSize(SOL.leverageTiers, toBaseLots(1_000n)), 25);
    const midway = maxLeverageForSize(
      SOL.leverageTiers,
      toBaseLots(48_247_026n),
    );
    assert.ok(midway < 25 && midway > 10, `expected 10..25, got ${midway}`);
    // Beyond the last tier Phoenix allows no leverage at all.
    assert.equal(
      maxLeverageForSize(SOL.leverageTiers, toBaseLots(999_999_999n)),
      1,
    );
  });
});

const exchangeStub = (
  overrides: Partial<{
    markets: Record<string, PhoenixMarket>;
    priced: readonly string[];
  }> = {},
): PhoenixExchangePort => {
  const markets = overrides.markets ?? { SOL };
  const priced = new Set(overrides.priced ?? Object.keys(markets));
  return {
    ready: async () => undefined,
    symbols: () => Object.keys(markets),
    activeSymbols: () =>
      Object.values(markets)
        .filter((market) => market.marketStatus === "active")
        .map((market) => market.symbol),
    market: (symbol) => markets[symbol],
    markPriceTicks: (symbol) => (priced.has(symbol) ? MARK_TICKS : undefined),
  };
};

const eligibility = (marketIds: readonly string[], expiresAt = 2_000n) => ({
  listHash: "a".repeat(64),
  nonce: 1n,
  expiresAt,
  marketIds,
});

describe("market selection", () => {
  it("selects a market that is both live and eligible", async () => {
    const selector = new PerpMarketSelector(exchangeStub());
    const result = await selector.select("SOL", eligibility(["SOL"]), 1_000n);
    assert.equal(result.kind, "selected");
  });

  it("names which gate failed, because the responses differ", async () => {
    const selector = new PerpMarketSelector(exchangeStub());

    const notEligible = await selector.select("SOL", eligibility(["BTC"]), 1_000n);
    assert.deepEqual(notEligible, {
      kind: "rejected",
      rejection: { kind: "not_eligible", market: "SOL" },
    });

    const notListed = await selector.select("DOGE", eligibility(["DOGE"]), 1_000n);
    assert.equal(
      notListed.kind === "rejected" && notListed.rejection.kind,
      "not_listed",
    );

    const expired = await selector.select(
      "SOL",
      eligibility(["SOL"], 500n),
      1_000n,
    );
    assert.equal(
      expired.kind === "rejected" && expired.rejection.kind,
      "list_expired",
    );
  });

  it("refuses a halted market even when it is eligible", async () => {
    const selector = new PerpMarketSelector(
      exchangeStub({ markets: { SOL: { ...SOL, marketStatus: "halted" } } }),
    );
    const result = await selector.select("SOL", eligibility(["SOL"]), 1_000n);
    assert.equal(
      result.kind === "rejected" && result.rejection.kind,
      "not_tradeable",
    );
  });

  it("refuses a market it cannot price", async () => {
    // No mark price means it cannot be sized or verified against, whatever its
    // status says.
    const selector = new PerpMarketSelector(exchangeStub({ priced: [] }));
    const result = await selector.select("SOL", eligibility(["SOL"]), 1_000n);
    assert.equal(
      result.kind === "rejected" && result.rejection.kind,
      "not_priceable",
    );
  });

  it("surfaces eligible markets Phoenix no longer lists", async () => {
    const selector = new PerpMarketSelector(exchangeStub());
    const stale = await selector.staleEligibleSymbols(
      eligibility(["SOL", "DELISTED"]),
    );
    assert.deepEqual(stale, ["DELISTED"]);
  });
});

const snapshot = (
  slotValue: bigint,
  collateral: string,
  positionLots: string,
  entryTicks = "10634",
): PhoenixTraderStateSnapshot => ({
  slot: slotValue.toString(),
  subaccounts: [
    {
      subaccountIndex: 1,
      collateral,
      positions: [
        {
          symbol: "SOL",
          basePositionLots: positionLots,
          virtualQuotePositionLots: "0",
          entryPriceTicks: entryTicks,
          unsettledFundingQuoteLots: "0",
        },
      ],
    },
  ],
});

const traderStateStub = (
  snapshots: readonly PhoenixTraderStateSnapshot[],
): PhoenixTraderStatePort => {
  let index = 0;
  return {
    getSnapshot: async () => {
      const value = snapshots[Math.min(index, snapshots.length - 1)]!;
      index += 1;
      return value;
    },
  };
};

describe("post-execution verification", () => {
  const params = {
    authority: "authority",
    traderPdaIndex: 0,
    subaccountIndex: isolatedSubaccount(1),
    market: "SOL",
  };

  it("refuses a snapshot that predates the execution, then accepts a fresh one", async () => {
    // Reading too early gives the position as it was *before* the trade, which
    // would produce a receipt asserting numbers that were true in the past.
    const state = await readVerifiedState(
      traderStateStub([
        snapshot(98n, "8000000", "0"),
        snapshot(99n, "8000000", "0"),
        snapshot(100n, "7994603", "15"),
      ]),
      { ...params, minSlot: slot(100n) },
      { maxAttempts: 5, onRetry: async () => undefined },
    );
    assert.equal(state.observedAtSlot as bigint, 100n);
    assert.equal(state.basePositionLots as bigint, 15n);
  });

  it("errors rather than settling when state never catches up", async () => {
    await assert.rejects(
      readVerifiedState(
        traderStateStub([snapshot(50n, "8000000", "0")]),
        { ...params, minSlot: slot(100n) },
        { maxAttempts: 3, onRetry: async () => undefined },
      ),
      VerificationError,
    );
  });

  it("errors when the isolated subaccount does not exist", async () => {
    await assert.rejects(
      readVerifiedState(
        traderStateStub([{ slot: "100", subaccounts: [] }]),
        { ...params, minSlot: slot(100n) },
        { maxAttempts: 1 },
      ),
      /does not exist in Phoenix state/,
    );
  });

  it("reports a flat position as having no entry price", async () => {
    const state = await readVerifiedState(
      traderStateStub([snapshot(100n, "0", "0")]),
      { ...params, minSlot: slot(100n) },
      { maxAttempts: 1 },
    );
    assert.equal(state.entryPriceTicks, null);
  });
});

const verified = (
  overrides: Partial<VerifiedExecutionState> = {},
): VerifiedExecutionState => ({
  subaccountIndex: isolatedSubaccount(1),
  collateralQuoteLots: quoteLots(7_994_603n),
  basePositionLots: toBaseLots(15n),
  virtualQuotePositionLots: quoteLots(0n),
  entryPriceTicks: priceTicks(10_634n),
  unsettledFundingQuoteLots: quoteLots(0n),
  observedAtSlot: slot(100n),
  ...overrides,
});

describe("execution assessment", () => {
  const expectation = {
    requestedCollateralUnits: collateralUnits(8_000_000n),
    requestedPositionLots: toBaseLots(15n),
    toleranceBps: bps(500),
    positionBefore: toBaseLots(0n),
  };

  it("records the real margin, not the requested amount", () => {
    // The exact case the first real mainnet trade produced: 8.000000 requested,
    // 7.994603 actually posted, the difference being Phoenix's taker fee.
    const result = assessExecution({
      state: verified(),
      expectation,
      scale: SCALE,
      side: "open",
    });
    assert.equal(result.kind, "filled");
    assert.equal(result.actualMarginPostedUnits as bigint, 7_994_603n);
    assert.notEqual(
      result.actualMarginPostedUnits as bigint,
      expectation.requestedCollateralUnits as bigint,
    );
    assert.equal(result.divergence, null, "0.07% is inside a 5% tolerance");
  });

  it("derives a partial fill from how the position actually moved", () => {
    // Phoenix reports no fill status: market orders are IOC, so the only
    // evidence is the position delta.
    const result = assessExecution({
      state: verified({ basePositionLots: toBaseLots(9n) }),
      expectation,
      scale: SCALE,
      side: "open",
    });
    assert.equal(result.kind, "partially_filled");
    assert.equal(result.filledLots as bigint, 9n);
  });

  it("rejects an order that filled nothing", () => {
    const result = assessExecution({
      state: verified({ basePositionLots: toBaseLots(0n) }),
      expectation,
      scale: SCALE,
      side: "open",
    });
    assert.equal(result.kind, "rejected");
  });

  it("flags a divergence past the caller's tolerance", () => {
    const result = assessExecution({
      state: verified({ collateralQuoteLots: quoteLots(4_000_000n) }),
      expectation,
      scale: SCALE,
      side: "open",
    });
    assert.equal(result.kind, "filled");
    assert.ok(result.divergence, "half the requested margin must diverge");
    assert.equal(result.divergence.marginDeviationBps, 5_000);
  });

  it("refuses to record an open with no readable entry price", () => {
    const result = assessExecution({
      state: verified({ entryPriceTicks: null }),
      expectation,
      scale: SCALE,
      side: "open",
    });
    assert.equal(result.kind, "rejected");
  });

  it("accepts a full close with no entry price and no residual margin", () => {
    // Flattening leaves nothing to price and sweeps the collateral back to the
    // parent, so a real close reports zero for both. Observed on mainnet.
    const result = assessExecution({
      state: verified({
        basePositionLots: toBaseLots(0n),
        entryPriceTicks: null,
        collateralQuoteLots: quoteLots(0n),
      }),
      expectation: { ...expectation, positionBefore: toBaseLots(15n) },
      scale: SCALE,
      side: "close",
    });
    assert.equal(result.kind, "filled");
    assert.equal(result.entryMarkPrice as bigint, 0n);
    assert.equal(result.actualMarginPostedUnits as bigint, 0n);
    // A close releases collateral rather than posting it, so the margin figure
    // must not be measured against the request.
    assert.equal(result.divergence, null);
  });
});
