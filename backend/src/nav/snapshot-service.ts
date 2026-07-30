import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { accrueManagementFee } from "../accounting/math.js";
import type {
  BasketAttributedHolding,
  BasketAttributedHoldingsPort,
  BasketShareSupplyPort,
  ClockPort,
  MarkFallbackReason,
  NavHoldingValue,
  NavSnapshot,
  NavSnapshotStorePort,
  ResolvedMark,
  StaleOrIlliquidMarkPolicyPort,
} from "./types.js";

export const NAV_SHARE_PRICE_SCALE = 1_000_000n;
export const U64_MAX = 18_446_744_073_709_551_615n;

export class UnsupportedMarkFallbackError extends Error {
  public constructor(basketId: string, tokenId: string, reason: MarkFallbackReason) {
    super(`No mark fallback policy is implemented for ${basketId}/${tokenId}: ${reason}`);
    this.name = "UnsupportedMarkFallbackError";
  }
}

/** Explicit policy boundary: production must choose a policy before using non-fresh marks. */
export class UnimplementedStaleOrIlliquidMarkPolicy implements StaleOrIlliquidMarkPolicyPort {
  public async resolve(context: {
    readonly basketId: string;
    readonly holding: BasketAttributedHolding;
    readonly reason: MarkFallbackReason;
  }): Promise<ResolvedMark> {
    throw new UnsupportedMarkFallbackError(
      context.basketId,
      context.holding.tokenId,
      context.reason,
    );
  }
}

export interface NavSnapshotServiceOptions {
  readonly maxMarkAgeMs: bigint;
  readonly sharePriceScale?: bigint;
}

export class NavInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NavInvariantError";
  }
}

const holdingKey = (holding: BasketAttributedHolding): string =>
  `${holding.marketId}\u0000${holding.tokenId}\u0000${holding.outcome}`;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const requireNonEmpty = (value: string, field: string): void => {
  if (value.length === 0) throw new NavInvariantError(`${field} must not be empty`);
};

const requireBoundedText = (value: string, field: string, maxUtf8Bytes: number): void => {
  requireNonEmpty(value, field);
  if (Buffer.byteLength(value, "utf8") > maxUtf8Bytes || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new NavInvariantError(`${field} is not a valid bounded identifier`);
  }
};

const requireSha256Hex = (value: string, field: string): void => {
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) {
    throw new NavInvariantError(`${field} must be a 32-byte hexadecimal hash`);
  }
};

const requireU64 = (value: bigint, field: string): void => {
  if (value < 0n || value > U64_MAX) {
    throw new NavInvariantError(`${field} must fit in an unsigned 64-bit integer`);
  }
};

const deepFreezeHolding = (holding: NavHoldingValue): NavHoldingValue => Object.freeze(holding);

const hashPayload = (snapshot: Omit<NavSnapshot, "hash">): string => {
  const canonical = JSON.stringify([
    "ALPHABASKET_NAV_SNAPSHOT_V1",
    snapshot.version,
    snapshot.basketId,
    snapshot.ledgerVersion,
    snapshot.compositionVersion.toString(),
    snapshot.compositionHash,
    snapshot.shareSupplySourceSlot.toString(),
    snapshot.shareSupplySourceVersion,
    snapshot.sequence.toString(),
    snapshot.observedAtMs.toString(),
    snapshot.idlePusdUnits.toString(),
    (snapshot.idleUsdcUnits ?? 0n).toString(),
    snapshot.positionValuePusdUnits.toString(),
    snapshot.grossNavPusdUnits.toString(),
    snapshot.onchainTotalSharesUnits.toString(),
    snapshot.totalSharesUnits.toString(),
    snapshot.projectedManagementFeeSharesUnits.toString(),
    snapshot.managementFeeAccrualThroughSeconds.toString(),
    snapshot.sharePriceUnits?.toString() ?? null,
    snapshot.sharePriceScale.toString(),
    snapshot.holdings.map((holding) => [
      holding.marketId,
      holding.assetKind ?? "prediction_market",
      holding.tokenId,
      holding.outcome,
      holding.quantityUnits.toString(),
      holding.markPriceUnits.toString(),
      holding.priceScale.toString(),
      holding.valuePusdUnits.toString(),
      holding.markObservedAtMs.toString(),
      holding.markSourceHash,
    ]),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
};

export class NavSnapshotService {
  private readonly sharePriceScale: bigint;

  public constructor(
    private readonly holdings: BasketAttributedHoldingsPort,
    private readonly shares: BasketShareSupplyPort,
    private readonly store: NavSnapshotStorePort,
    private readonly markFallback: StaleOrIlliquidMarkPolicyPort,
    private readonly clock: ClockPort,
    private readonly options: NavSnapshotServiceOptions,
  ) {
    if (options.maxMarkAgeMs < 0n) {
      throw new RangeError("maxMarkAgeMs must be non-negative");
    }
    this.sharePriceScale = options.sharePriceScale ?? NAV_SHARE_PRICE_SCALE;
    if (this.sharePriceScale <= 0n || this.sharePriceScale > U64_MAX) {
      throw new RangeError("sharePriceScale must be a positive u64");
    }
  }

  public async createSnapshot(basketId: string): Promise<NavSnapshot> {
    if (basketId.length === 0) {
      throw new TypeError("basketId must not be empty");
    }
    const observedAtMs = this.clock.nowMs();
    if (observedAtMs < 0n) {
      throw new NavInvariantError("snapshot time must be non-negative");
    }
    requireU64(observedAtMs, "observedAtMs");
    const [state, shareSupply, sequence] = await Promise.all([
      this.holdings.loadBasketState(basketId),
      this.shares.loadShareSupply(basketId),
      this.store.nextSequence(basketId),
    ]);
    if (state.basketId !== basketId) {
      throw new NavInvariantError("holdings provider returned a different basket");
    }
    const onchainTotalSharesUnits = shareSupply.totalSharesUnits;
    if (
      state.idlePusdUnits < 0n ||
      (state.idleUsdcUnits ?? 0n) < 0n ||
      onchainTotalSharesUnits < 0n ||
      sequence < 0n
    ) {
      throw new NavInvariantError("NAV inputs and sequence must be non-negative");
    }
    requireBoundedText(state.ledgerVersion, "ledgerVersion", 128);
    requireSha256Hex(state.compositionHash, "compositionHash");
    requireBoundedText(shareSupply.sourceVersion, "shareSupply.sourceVersion", 128);
    requireU64(state.compositionVersion, "compositionVersion");
    if (state.compositionVersion === 0n) {
      throw new NavInvariantError("compositionVersion must be positive");
    }
    requireU64(shareSupply.sourceSlot, "shareSupply.sourceSlot");
    requireU64(sequence, "sequence");
    requireU64(onchainTotalSharesUnits, "onchainTotalSharesUnits");
    requireU64(shareSupply.protocolFeeSharesUnits, "protocolFeeSharesUnits");
    requireU64(state.idlePusdUnits, "idlePusdUnits");
    requireU64(state.idleUsdcUnits ?? 0n, "idleUsdcUnits");
    const managementFeeAccrualThroughSeconds = observedAtMs / 1_000n;
    const projectedFeeState = accrueManagementFee(
      {
        totalSharesOutstanding: onchainTotalSharesUnits,
        protocolFeeShares: shareSupply.protocolFeeSharesUnits,
        lastManagementFeeAt: shareSupply.lastManagementFeeAtSeconds,
        managementFeeAccrualRemainder:
          shareSupply.managementFeeAccrualRemainder,
      },
      managementFeeAccrualThroughSeconds,
    );
    const totalSharesUnits = projectedFeeState.totalSharesOutstanding;

    const ordered = [...state.holdings].sort((left, right) =>
      compareCodeUnits(holdingKey(left), holdingKey(right)),
    );
    const seen = new Set<string>();
    const valued: NavHoldingValue[] = [];
    let positionValuePusdUnits = 0n;

    for (const holding of ordered) {
      const key = holdingKey(holding);
      if (seen.has(key)) {
        throw new NavInvariantError(`duplicate attributed holding ${key}`);
      }
      seen.add(key);
      requireBoundedText(holding.marketId, "holding.marketId", 64);
      const assetKind = holding.assetKind ?? "prediction_market";
      if (
        assetKind === "prediction_market" &&
        !/^(?:0|[1-9][0-9]*)$/.test(holding.tokenId)
      ) {
        throw new NavInvariantError("prediction holding tokenId must be a canonical unsigned decimal integer");
      }
      if (assetKind === "spot") {
        try {
          if (new PublicKey(holding.tokenId).equals(PublicKey.default)) {
            throw new Error("zero mint");
          }
        } catch {
          throw new NavInvariantError("spot holding tokenId must be a non-zero Solana mint");
        }
        if (
          holding.tokenDecimals === undefined ||
          !Number.isInteger(holding.tokenDecimals) ||
          holding.tokenDecimals < 0 ||
          holding.tokenDecimals > 18 ||
          holding.priceScale !== 10n ** BigInt(holding.tokenDecimals)
        ) {
          throw new NavInvariantError("spot holding price scale does not match token decimals");
        }
      }
      requireBoundedText(holding.outcome, "holding.outcome", 64);
      requireBoundedText(holding.markSourceHash, "holding.markSourceHash", 256);
      const resolvedMark = await this.resolveMark(basketId, holding, observedAtMs);
      const markPriceUnits = resolvedMark.priceUnits;
      if (holding.quantityUnits < 0n || holding.priceScale <= 0n) {
        throw new NavInvariantError(`invalid quantity or price scale for ${holding.tokenId}`);
      }
      if (
        markPriceUnits < 0n ||
        (assetKind === "prediction_market" && markPriceUnits > holding.priceScale)
      ) {
        throw new NavInvariantError(`mark price is outside its asset bounds for ${holding.tokenId}`);
      }
      requireU64(holding.quantityUnits, "holding.quantityUnits");
      requireU64(holding.priceScale, "holding.priceScale");
      requireU64(markPriceUnits, "holding.markPriceUnits");
      requireU64(resolvedMark.observedAtMs, "holding.markObservedAtMs");
      requireBoundedText(resolvedMark.sourceHash, "holding.markSourceHash", 256);
      const valuePusdUnits = (holding.quantityUnits * markPriceUnits) / holding.priceScale;
      positionValuePusdUnits += valuePusdUnits;
      valued.push(
        deepFreezeHolding({
          marketId: holding.marketId,
          assetKind,
          tokenId: holding.tokenId,
          outcome: holding.outcome,
          quantityUnits: holding.quantityUnits,
          markPriceUnits,
          priceScale: holding.priceScale,
          valuePusdUnits,
          markObservedAtMs: resolvedMark.observedAtMs,
          markSourceHash: resolvedMark.sourceHash,
        }),
      );
    }

    const grossNavPusdUnits =
      positionValuePusdUnits + state.idlePusdUnits + (state.idleUsdcUnits ?? 0n);
    const sharePriceUnits =
      totalSharesUnits === 0n
        ? null
        : (grossNavPusdUnits * this.sharePriceScale) / totalSharesUnits;
    requireU64(positionValuePusdUnits, "positionValuePusdUnits");
    requireU64(grossNavPusdUnits, "grossNavPusdUnits");
    if (sharePriceUnits !== null) requireU64(sharePriceUnits, "sharePriceUnits");
    const withoutHash: Omit<NavSnapshot, "hash"> = Object.freeze({
      version: 1 as const,
      basketId,
      ledgerVersion: state.ledgerVersion,
      compositionVersion: state.compositionVersion,
      compositionHash: state.compositionHash,
      shareSupplySourceSlot: shareSupply.sourceSlot,
      shareSupplySourceVersion: shareSupply.sourceVersion,
      sequence,
      observedAtMs,
      idlePusdUnits: state.idlePusdUnits,
      idleUsdcUnits: state.idleUsdcUnits ?? 0n,
      positionValuePusdUnits,
      grossNavPusdUnits,
      onchainTotalSharesUnits,
      totalSharesUnits,
      projectedManagementFeeSharesUnits: projectedFeeState.mintedShares,
      managementFeeAccrualThroughSeconds,
      sharePriceUnits,
      sharePriceScale: this.sharePriceScale,
      holdings: Object.freeze(valued),
    });
    const snapshot: NavSnapshot = Object.freeze({ ...withoutHash, hash: hashPayload(withoutHash) });
    await this.store.append(snapshot);
    return snapshot;
  }

  private async resolveMark(
    basketId: string,
    holding: BasketAttributedHolding,
    observedAtMs: bigint,
  ): Promise<ResolvedMark> {
    if (holding.markObservedAtMs > observedAtMs) {
      throw new NavInvariantError(`mark timestamp is in the future for ${holding.tokenId}`);
    }
    let reason: MarkFallbackReason | null = null;
    if (holding.markCondition === "stale") {
      reason = "declared-stale";
    } else if (holding.markCondition === "illiquid") {
      reason = "declared-illiquid";
    } else if (holding.markCondition === "unavailable") {
      reason = "unavailable";
    } else if (observedAtMs - holding.markObservedAtMs > this.options.maxMarkAgeMs) {
      reason = "too-old";
    }
    if (reason === null) {
      return Object.freeze({
        priceUnits: holding.markPriceUnits,
        observedAtMs: holding.markObservedAtMs,
        sourceHash: holding.markSourceHash,
      });
    }
    const resolved = await this.markFallback.resolve(
      Object.freeze({ basketId, holding, reason, snapshotTimeMs: observedAtMs }),
    );
    if (resolved.observedAtMs > observedAtMs || resolved.observedAtMs < 0n) {
      throw new NavInvariantError(`fallback mark timestamp is invalid for ${holding.tokenId}`);
    }
    requireBoundedText(resolved.sourceHash, "fallback mark sourceHash", 256);
    return Object.freeze({ ...resolved });
  }
}

export const hashNavSnapshotPayload = hashPayload;
