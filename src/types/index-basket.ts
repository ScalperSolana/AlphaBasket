/**
 * The index product's asset model.
 *
 * Deliberately separate from `types/basket.ts`, which models the older
 * prediction-market contest and is prediction-only (`outcome: 'YES' | 'NO'`, a
 * question string, an end timestamp). An index holds three kinds of thing and
 * needs a tagged union; retrofitting the old shape would have meant every
 * consumer carrying fields that are meaningless for two of the three.
 *
 * These mirror the backend's `IndexAssetView`, the quote/operation JSON from
 * `server/application-service.ts`, and the on-chain `PositionKind`.
 */

export type IndexAssetKind = "spot" | "perp" | "prediction_market";

export type PerpDirection = "long" | "short";

export interface PerpLeg {
  readonly direction: PerpDirection;
  /** 30000 is 3.00x. */
  readonly leverageBps: number;
  /** Post-execution figures, written by settlement. Zero before the first fill. */
  readonly entryMarkPrice: string;
  readonly marginPosted: string;
  /** Phoenix isolated subaccount. Always greater than zero. */
  readonly phoenixSubaccount: number;
}

export interface IndexAsset {
  readonly marketId: string;
  readonly kind: IndexAssetKind;
  readonly weightBps: number;
  readonly perp?: PerpLeg;
  readonly tokenMint?: string;
  readonly outcome?: number;
}

export interface IndexSummary {
  readonly address: string;
  readonly basketId: string;
  readonly status: string;
  /** Open-ended (never resolves) as opposed to a basket that settles on a date. */
  readonly isPerpetual: boolean;
  readonly compositionVersion: number;
  readonly performanceFeeBps: number;
  readonly totalSharesOutstanding: string;
  /** Null until the first deposit prices the index. */
  readonly sharePriceUnits: string | null;
  readonly grossNavUnits: string | null;
  readonly assetKinds: readonly IndexAssetKind[];
  readonly itemCount: number;
  readonly updatedAt: string | null;
}

export interface IndexDetail extends IndexSummary {
  readonly items: readonly IndexAsset[];
  readonly holderCount: number;
}

export interface PortfolioHolding {
  readonly basketAddress: string;
  readonly basketId: string;
  readonly sharesOwned: string;
  readonly costBasisValue: string;
  readonly currentValueUnits: string | null;
  readonly sharePriceUnits: string | null;
  readonly assetKinds: readonly IndexAssetKind[];
}

// --- quotes, intents and operations ------------------------------------------

interface QuoteCommon {
  readonly quoteHash: string;
  readonly basket: string;
  readonly user: string;
  readonly compositionVersion: number;
  readonly navReportHash: string;
  readonly basketNavValue: string;
  readonly sharePrice: string;
  readonly maxSlippageBps: number;
  readonly expiresAtSeconds: string;
}

export interface DepositQuote extends QuoteCommon {
  readonly kind: "deposit";
  readonly grossAmount: string;
  readonly protocolFee: string;
  readonly quotedNetValue: string;
  readonly minimumNetValue: string;
  readonly minSharesOut: string;
}

export interface WithdrawalQuote extends QuoteCommon {
  readonly kind: "withdrawal";
  readonly shareAmount: string;
  readonly quotedGrossValue: string;
  readonly minimumGrossValue: string;
  readonly minValueOut: string;
  readonly quotedProtocolFee: string;
  readonly quotedCreatorFee: string;
}

export type OperationWorkState =
  | "awaiting_funding"
  | "pending"
  | "claimed"
  | "dispatched"
  | "completed";

export interface Operation {
  readonly operationId: string;
  readonly kind: "deposit" | "withdrawal";
  readonly state: string;
  readonly workState: OperationWorkState;
  readonly workflowId: string;
  readonly basket: string;
  readonly user: string | null;
  readonly walletId: string;
  readonly fundingAddress: string | null;
  readonly fundingTransactionSignature: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FundingTransfer {
  readonly purpose: "polymarket_allocation" | "jupiter_allocation" | "protocol_deposit_fee" | string;
  readonly destination: string;
  readonly amount: string;
}

export interface DepositFunding {
  readonly transactionMustBeSignedBy: string;
  readonly settlementMint: string;
  readonly netAmount: string;
  readonly protocolFeeAmount: string;
  readonly protocolFeeDestination: string;
  readonly transfers: readonly FundingTransfer[];
}

export interface DepositOperation extends Operation {
  readonly funding: DepositFunding;
}

/** A leg being assembled in the builder, before it is published. */
export interface DraftLeg {
  readonly id: string;
  readonly kind: Exclude<IndexAssetKind, "prediction_market">;
  readonly marketId: string;
  readonly weightBps: number;
  /** Spot only. */
  readonly tokenMint?: string;
  /** Perp only. */
  readonly direction?: PerpDirection;
  readonly leverageBps?: number;
  readonly phoenixSubaccount?: number;
}

export const ASSET_KIND_LABEL: Record<IndexAssetKind, string> = {
  spot: "Spot",
  perp: "Perp",
  prediction_market: "Prediction",
};

/** Six decimals throughout, matching the program's accounting scale. */
export const UNITS_PER_USD = 1_000_000n;

export const formatUnits = (
  units: string | bigint | null | undefined,
  fractionDigits = 2,
): string => {
  if (units === null || units === undefined) return "—";
  try {
    const value = Number(BigInt(units)) / Number(UNITS_PER_USD);
    return value.toLocaleString(undefined, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
  } catch {
    return "—";
  }
};

export const formatUsd = (units: string | bigint | null | undefined): string =>
  units === null || units === undefined ? "—" : `$${formatUnits(units)}`;

/** Share counts share the six-decimal scale; show two decimals like a price. */
export const formatShares = (units: string | bigint | null | undefined): string =>
  formatUnits(units, 2);

export const formatBps = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

/** Short, stable label for an index, which has no user-facing name on chain. */
export const shortId = (basketId: string): string =>
  basketId ? `${basketId.slice(0, 6)}…${basketId.slice(-4)}` : "unknown";

export const shortAddress = (address: string, chars = 4): string =>
  address.length <= chars * 2 + 1 ? address : `${address.slice(0, chars)}…${address.slice(-chars)}`;

export const formatLeverage = (leverageBps: number): string =>
  `${(leverageBps / 10_000).toFixed(2).replace(/\.?0+$/, "")}x`;

/** Parse a user-typed decimal amount into six-decimal units. Null when unusable. */
export const parseUnits = (input: string): bigint | null => {
  const trimmed = input.trim().replace(/,/g, "");
  if (!/^\d*(?:\.\d*)?$/u.test(trimmed) || trimmed === "" || trimmed === ".") return null;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const padded = (fraction + "000000").slice(0, 6);
  const units = BigInt(whole || "0") * UNITS_PER_USD + BigInt(padded || "0");
  return units > 0n ? units : null;
};

/**
 * Weights must total exactly 10000, and no single leg may exceed 3000, so a
 * valid index has at least four legs. Both bounds are the program's, enforced by
 * `validate_basket_items`; the builder checks them locally so a creator sees the
 * problem before paying for a rejected transaction.
 */
export const MAX_BPS = 10_000;
export const MAX_SINGLE_WEIGHT_BPS = 3_000;
export const MIN_LEGS = 4;
export const MAX_LEGS = 16;

export interface DraftValidation {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly totalWeightBps: number;
}

export const validateDraft = (legs: readonly DraftLeg[]): DraftValidation => {
  const problems: string[] = [];
  const totalWeightBps = legs.reduce((sum, leg) => sum + leg.weightBps, 0);

  if (legs.length < MIN_LEGS) {
    problems.push(
      `Add at least ${MIN_LEGS} legs. No single leg may exceed ${MAX_SINGLE_WEIGHT_BPS / 100}%, so fewer cannot reach 100%.`,
    );
  }
  if (legs.length > MAX_LEGS) {
    problems.push(`An index may hold at most ${MAX_LEGS} legs.`);
  }
  if (totalWeightBps !== MAX_BPS) {
    problems.push(
      `Weights must total 100%. They currently total ${(totalWeightBps / 100).toFixed(2)}%.`,
    );
  }
  for (const leg of legs) {
    if (leg.weightBps <= 0 || leg.weightBps > MAX_SINGLE_WEIGHT_BPS) {
      problems.push(
        `${leg.marketId || "A leg"} must weigh between 0% and ${MAX_SINGLE_WEIGHT_BPS / 100}%.`,
      );
    }
    if (!leg.marketId.trim()) {
      problems.push("Every leg needs a market.");
    }
  }

  const markets = legs.map((leg) => leg.marketId);
  if (new Set(markets).size !== markets.length) {
    problems.push("Each market can appear only once.");
  }

  const kinds = new Set(legs.map((leg) => leg.kind));
  if (kinds.has("perp") && kinds.size > 1) {
    problems.push(
      "A perp index cannot also hold spot. Leveraged and unleveraged positions cannot share one NAV.",
    );
  }

  const subaccounts = legs
    .filter((leg) => leg.kind === "perp")
    .map((leg) => leg.phoenixSubaccount);
  if (new Set(subaccounts).size !== subaccounts.length) {
    problems.push(
      "Two perp legs share an isolated subaccount. Each needs its own, or they would share collateral.",
    );
  }

  return { ok: problems.length === 0, problems: [...new Set(problems)], totalWeightBps };
};
