/**
 * Vault-delta verification.
 *
 * **Every value recorded on chain is read back from real post-execution state,
 * never from a quote or a simulation.** If the real value cannot be read, the
 * trade does not settle — it errors.
 *
 * This is the file that makes that true. Nothing downstream of here ever sees a
 * quoted number. It earned its keep on the first real trade: a request funded
 * exactly 8.000000 USDC of margin and Phoenix reported 7.994603 afterwards, the
 * difference being the taker fee. A receipt built from the request would have
 * been wrong on the very first fill.
 */

import {
  absBigInt,
  baseLots as toBaseLots,
  collateralUnits,
  deviationBps,
  priceTicks as toPriceTicks,
  quoteLots,
  quoteLotsToCollateralUnits,
  slot as toSlot,
  ticksToQuoteLotsPerBaseLot,
  type BaseLots,
  type Bps,
  type CollateralUnits,
  type MarketScale,
  type QuoteLotsPerBaseLot,
  type Slot,
} from "./units.js";
import type {
  DivergenceReport,
  IsolatedSubaccountIndex,
  PhoenixTraderStatePort,
  PhoenixTraderStateSnapshot,
  VerifiedExecutionState,
} from "./types.js";

export class VerificationError extends Error {
  override readonly name = "VerificationError";
}

const readOnce = async (
  traderState: PhoenixTraderStatePort,
  params: {
    authority: string;
    traderPdaIndex: number;
    subaccountIndex: IsolatedSubaccountIndex;
    market: string;
  },
): Promise<VerifiedExecutionState> => {
  const snapshot = await traderState.getSnapshot(
    params.authority,
    params.traderPdaIndex,
  );
  const subaccount = snapshot.subaccounts.find(
    (candidate) => candidate.subaccountIndex === (params.subaccountIndex as number),
  );

  if (!subaccount) {
    throw new VerificationError(
      `isolated subaccount ${params.subaccountIndex} does not exist in Phoenix state for ` +
        `${params.authority}; there is nothing to verify against`,
    );
  }

  const position = subaccount.positions.find(
    (candidate) => candidate.symbol === params.market,
  );

  return {
    subaccountIndex: params.subaccountIndex,
    // Isolated: this collateral backs this position and nothing else.
    collateralQuoteLots: quoteLots(BigInt(subaccount.collateral)),
    basePositionLots: toBaseLots(
      position ? BigInt(position.basePositionLots) : 0n,
    ),
    virtualQuotePositionLots: quoteLots(
      position ? BigInt(position.virtualQuotePositionLots) : 0n,
    ),
    entryPriceTicks:
      position && BigInt(position.basePositionLots) !== 0n
        ? toPriceTicks(BigInt(position.entryPriceTicks))
        : null,
    unsettledFundingQuoteLots: quoteLots(
      position ? BigInt(position.unsettledFundingQuoteLots) : 0n,
    ),
    observedAtSlot: toSlot(BigInt(snapshot.slot)),
  };
};

export interface ReadVerifiedStateOptions {
  readonly maxAttempts?: number;
  /** Called between attempts, so callers own the backoff. */
  readonly onRetry?: (attempt: number) => Promise<void>;
}

/**
 * Reads post-execution state at a slot no earlier than `minSlot`.
 *
 * A snapshot taken the instant after a send can predate the fill, and reading
 * pre-execution state as if it were post-execution would produce a receipt
 * asserting numbers that were true before the trade. Retries a stale snapshot
 * rather than accepting it, and gives up rather than settling against one.
 */
export const readVerifiedState = async (
  traderState: PhoenixTraderStatePort,
  params: {
    authority: string;
    traderPdaIndex: number;
    subaccountIndex: IsolatedSubaccountIndex;
    market: string;
    minSlot: Slot;
  },
  options: ReadVerifiedStateOptions = {},
): Promise<VerifiedExecutionState> => {
  const maxAttempts = options.maxAttempts ?? 5;
  let last: VerifiedExecutionState | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const state = await readOnce(traderState, params);
    last = state;
    if ((state.observedAtSlot as bigint) >= (params.minSlot as bigint)) {
      return state;
    }
    if (attempt < maxAttempts) await options.onRetry?.(attempt);
  }

  throw new VerificationError(
    `Phoenix state never advanced to slot ${params.minSlot} after ${maxAttempts} attempts ` +
      `(last saw ${last?.observedAtSlot ?? "nothing"}); refusing to settle against a ` +
      "snapshot that may predate the execution",
  );
};

export interface ExecutionExpectation {
  readonly requestedCollateralUnits: CollateralUnits;
  readonly requestedPositionLots: BaseLots;
  readonly toleranceBps: Bps;
  /** Position size before the trade, so the delta can be isolated. */
  readonly positionBefore: BaseLots;
}

export type ExecutionAssessment =
  | { readonly kind: "rejected"; readonly reason: string }
  | {
      readonly kind: "filled" | "partially_filled";
      readonly actualMarginPostedUnits: CollateralUnits;
      readonly entryMarkPrice: QuoteLotsPerBaseLot;
      readonly resultingPositionLots: BaseLots;
      readonly filledLots: BaseLots;
      readonly divergence: DivergenceReport | null;
    };

/**
 * Turns post-execution state into an outcome.
 *
 * Fill status is **derived**, because Phoenix does not report one: market orders
 * are immediate-or-cancel, so the only evidence of what happened is how the
 * position moved.
 */
export const assessExecution = (params: {
  state: VerifiedExecutionState;
  expectation: ExecutionExpectation;
  scale: MarketScale;
  side: "open" | "close";
}): ExecutionAssessment => {
  const { state, expectation, scale } = params;

  const before = expectation.positionBefore as bigint;
  const after = state.basePositionLots as bigint;
  const filled = absBigInt(after - before);
  const requested = absBigInt(expectation.requestedPositionLots as bigint);

  if (filled === 0n) {
    return {
      kind: "rejected",
      reason:
        `Phoenix position on ${scale.symbol} is unchanged at ${after} base lots after ` +
        "execution: the IOC order filled nothing",
    };
  }

  const actualMargin = quoteLotsToCollateralUnits(state.collateralQuoteLots);

  // Entry price comes from post-execution position state, never from the quote.
  // A close that flattens the position has no entry price left to read.
  const entryTicks = state.entryPriceTicks;

  if (params.side === "open" && entryTicks === null) {
    return {
      kind: "rejected",
      reason:
        `opened a position on ${scale.symbol} but Phoenix reports no entry price; ` +
        "refusing to record a price that cannot be read",
    };
  }

  const entryMarkPrice = ticksToQuoteLotsPerBaseLot(
    entryTicks ?? toPriceTicks(0n),
    scale,
  );

  // Margin deviation is only meaningful when opening. A close *releases*
  // collateral rather than posting it, so comparing the residual balance against
  // the request would flag every successful close as a divergence. On a close,
  // size is the thing that matters: did the position actually go away.
  const marginDeviation =
    params.side === "open"
      ? deviationBps(
          expectation.requestedCollateralUnits as bigint,
          actualMargin as bigint,
        )
      : 0;
  const sizeDeviation = deviationBps(requested, filled);
  const tolerance = expectation.toleranceBps as number;

  const divergence: DivergenceReport | null =
    marginDeviation > tolerance || sizeDeviation > tolerance
      ? {
          requestedCollateralUnits: expectation.requestedCollateralUnits,
          actualMarginPostedUnits: actualMargin,
          marginDeviationBps: marginDeviation,
          requestedPositionLots: expectation.requestedPositionLots,
          actualPositionLots: toBaseLots(filled),
          sizeDeviationBps: sizeDeviation,
          toleranceBps: expectation.toleranceBps,
        }
      : null;

  return {
    kind: filled < requested ? "partially_filled" : "filled",
    actualMarginPostedUnits: actualMargin,
    entryMarkPrice,
    resultingPositionLots: state.basePositionLots,
    filledLots: toBaseLots(filled),
    divergence,
  };
};

/** Collateral an isolated subaccount holds, or zero if it has none. */
export const readIsolatedCollateral = (
  snapshot: PhoenixTraderStateSnapshot,
  subaccountIndex: IsolatedSubaccountIndex,
): CollateralUnits => {
  const subaccount = snapshot.subaccounts.find(
    (candidate) => candidate.subaccountIndex === (subaccountIndex as number),
  );
  return collateralUnits(subaccount ? BigInt(subaccount.collateral) : 0n);
};

/** Signed position size an isolated subaccount holds in a market. */
export const readIsolatedPosition = (
  snapshot: PhoenixTraderStateSnapshot,
  subaccountIndex: IsolatedSubaccountIndex,
  market: string,
): BaseLots => {
  const position = snapshot.subaccounts
    .find((candidate) => candidate.subaccountIndex === (subaccountIndex as number))
    ?.positions.find((candidate) => candidate.symbol === market);
  return toBaseLots(position ? BigInt(position.basePositionLots) : 0n);
};
