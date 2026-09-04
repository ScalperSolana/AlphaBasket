import { createHash } from "node:crypto";

import { PublicKey } from "@solana/web3.js";

import type { FakExecutionPort, FakOrderResult } from "../execution/types.js";
import { compositionHash } from "../contract/composition.js";
import type {
  JupiterExecutionPort,
  JupiterPricePort,
  JupiterTokenDirectoryPort,
} from "../jupiter/types.js";
import type {
  BasketAttributedHolding,
  BasketAttributedHoldingsPort,
  BasketAttributedState,
} from "../nav/types.js";
import { PRICE_SCALE, type ClobMarketDataPort, type OrderBook } from "../polymarket/types.js";
import type { JsonValue } from "../persistence/outbox.js";
import type { WalletExecutionCoordinatorPort } from "../wallets/types.js";
import { NOOP_FAULT_INJECTOR, type FaultInjectorPort } from "../resilience/index.js";
import type { FinancialExecutionGuardPort } from "../operations/index.js";
import type { LifecycleExternalExecutionStorePort } from "./execution-store.js";
import type {
  ClockPort,
  ReconstitutionExecutionPort,
  ReconstitutionExecutionResult,
  SignedReconstitution,
} from "./types.js";

const BPS = 10_000n;

const divCeil = (numerator: bigint, denominator: bigint): bigint => {
  if (numerator < 0n || denominator <= 0n) throw new RangeError("invalid ceiling division");
  return numerator === 0n ? 0n : ((numerator - 1n) / denominator) + 1n;
};

const tokenIdFromBytes = (value: Uint8Array): string => {
  if (value.byteLength !== 32 || Buffer.from(value).equals(Buffer.alloc(32))) throw new TypeError("CTF token ID must be non-zero bytes32");
  return BigInt(`0x${Buffer.from(value).toString("hex")}`).toString(10);
};

function requestHash(request: {
  readonly basket: string;
  readonly previousCompositionVersion: number;
  readonly nextComposition: SignedReconstitution;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "ALPHABASKET_RECONSTITUTION_EXECUTION_V1",
    request.basket,
    request.previousCompositionVersion,
    request.nextComposition.nextCompositionVersion,
    Buffer.from(request.nextComposition.compositionHash).toString("hex"),
  ]), "utf8").digest("hex");
}

function executionResultFromJson(value: JsonValue): ReconstitutionExecutionResult {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("stored reconstitution result is invalid");
  const record = value as { readonly [key: string]: JsonValue };
  const executionHash = record.executionHash;
  const orderIds = record.orderIds;
  const jupiterTransactions = record.jupiterTransactions;
  const realized = record.realizedPusdDeltaUnits;
  const realizedUsdc = record.realizedUsdcDeltaUnits;
  const executedAt = record.executedAtMs;
  if (typeof executionHash !== "string" || !/^[0-9a-f]{64}$/u.test(executionHash) ||
      !Array.isArray(orderIds) || !orderIds.every((item) => typeof item === "string") ||
      (jupiterTransactions !== undefined &&
       (!Array.isArray(jupiterTransactions) ||
        !jupiterTransactions.every((item) => typeof item === "string"))) ||
      typeof realized !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(realized) ||
      (realizedUsdc !== undefined &&
       (typeof realizedUsdc !== "string" ||
        !/^-?(?:0|[1-9][0-9]*)$/u.test(realizedUsdc))) ||
      typeof executedAt !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(executedAt)) {
    throw new Error("stored reconstitution result is incomplete");
  }
  return Object.freeze({
    executionHash,
    orderIds: Object.freeze(orderIds as string[]),
    ...(jupiterTransactions === undefined
      ? {}
      : {
          jupiterTransactions: Object.freeze(
            jupiterTransactions as string[],
          ),
        }),
    realizedPusdDeltaUnits: BigInt(realized),
    ...(realizedUsdc === undefined
      ? {}
      : { realizedUsdcDeltaUnits: BigInt(realizedUsdc) }),
    executedAtMs: BigInt(executedAt),
  });
}

interface MarketView {
  readonly tokenId: string;
  readonly conditionId: string;
  readonly negativeRisk: boolean;
  readonly minOrderSizeUnits: bigint;
  readonly observedAtMs: bigint;
  readonly sourceHash: string;
  readonly midpoint: bigint;
  readonly worstBuy: bigint;
  readonly worstSell: bigint;
}

type HybridAssetView =
  | Readonly<{
      kind: "prediction_market";
      key: string;
      market: MarketView;
    }>
  | Readonly<{
      kind: "spot";
      key: string;
      tokenId: string;
      tokenDecimals: number;
      observedAtMs: bigint;
      sourceHash: string;
      midpoint: bigint;
      priceScale: bigint;
    }>;

const predictionKey = (tokenId: string): string => `prediction_market:${tokenId}`;
const spotKey = (mint: string): string => `spot:${mint}`;

function hybridValue(quantity: bigint, view: HybridAssetView): bigint {
  return view.kind === "prediction_market"
    ? (quantity * view.market.midpoint) / PRICE_SCALE
    : (quantity * view.midpoint) / view.priceScale;
}

function hybridQuantity(value: bigint, view: HybridAssetView): bigint {
  return view.kind === "prediction_market"
    ? (value * PRICE_SCALE) / view.market.midpoint
    : (value * view.priceScale) / view.midpoint;
}

function hybridPlanJson(
  views: ReadonlyMap<string, HybridAssetView>,
  maximumSlippageBps: number,
): JsonValue {
  return {
    version: "alphabasket/reconstitution-hybrid-plan-v1",
    maximumSlippageBps: maximumSlippageBps.toString(10),
    views: [...views.values()]
      .sort((left, right) => left.key.localeCompare(right.key, "en"))
      .map((view) => view.kind === "prediction_market"
        ? {
            kind: view.kind,
            key: view.key,
            tokenId: view.market.tokenId,
            conditionId: view.market.conditionId,
            negativeRisk: view.market.negativeRisk,
            minOrderSizeUnits: view.market.minOrderSizeUnits.toString(10),
            observedAtMs: view.market.observedAtMs.toString(10),
            sourceHash: view.market.sourceHash,
            midpoint: view.market.midpoint.toString(10),
            worstBuy: view.market.worstBuy.toString(10),
            worstSell: view.market.worstSell.toString(10),
          }
        : {
            kind: view.kind,
            key: view.key,
            tokenId: view.tokenId,
            tokenDecimals: view.tokenDecimals.toString(10),
            observedAtMs: view.observedAtMs.toString(10),
            sourceHash: view.sourceHash,
            midpoint: view.midpoint.toString(10),
            priceScale: view.priceScale.toString(10),
          }),
  };
}

function hybridViewsFromJson(
  value: JsonValue,
  expectedKeys: readonly string[],
  maximumSlippageBps: number,
): ReadonlyMap<string, HybridAssetView> {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object"
  ) {
    throw new Error("stored hybrid reconstitution plan is invalid");
  }
  const record = value as { readonly [key: string]: JsonValue };
  if (
    record.version !== "alphabasket/reconstitution-hybrid-plan-v1" ||
    record.maximumSlippageBps !== maximumSlippageBps.toString(10) ||
    !Array.isArray(record.views)
  ) {
    throw new Error("stored hybrid reconstitution plan has an incompatible version or policy");
  }
  const integer = (
    item: { readonly [key: string]: JsonValue },
    name: string,
  ): bigint => {
    const field = item[name];
    if (
      typeof field !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(field)
    ) {
      throw new Error(`stored hybrid reconstitution ${name} is invalid`);
    }
    return BigInt(field);
  };
  const views = new Map<string, HybridAssetView>();
  for (const raw of record.views) {
    if (
      raw === null ||
      Array.isArray(raw) ||
      typeof raw !== "object"
    ) {
      throw new Error("stored hybrid reconstitution view is invalid");
    }
    const item = raw as { readonly [key: string]: JsonValue };
    if (
      typeof item.key !== "string" ||
      typeof item.tokenId !== "string" ||
      typeof item.sourceHash !== "string" ||
      item.sourceHash.length === 0 ||
      views.has(item.key)
    ) {
      throw new Error("stored hybrid reconstitution identity is invalid");
    }
    if (item.kind === "prediction_market") {
      if (
        !/^(?:0|[1-9][0-9]*)$/u.test(item.tokenId) ||
        typeof item.conditionId !== "string" ||
        !/^0x[0-9a-f]{64}$/u.test(item.conditionId) ||
        typeof item.negativeRisk !== "boolean"
      ) {
        throw new Error("stored hybrid prediction identity is invalid");
      }
      const market: MarketView = Object.freeze({
        tokenId: item.tokenId,
        conditionId: item.conditionId,
        negativeRisk: item.negativeRisk,
        minOrderSizeUnits: integer(item, "minOrderSizeUnits"),
        observedAtMs: integer(item, "observedAtMs"),
        sourceHash: item.sourceHash,
        midpoint: integer(item, "midpoint"),
        worstBuy: integer(item, "worstBuy"),
        worstSell: integer(item, "worstSell"),
      });
      if (
        item.key !== predictionKey(market.tokenId) ||
        market.minOrderSizeUnits <= 0n ||
        market.midpoint <= 0n ||
        market.midpoint >= PRICE_SCALE ||
        market.worstSell <= 0n ||
        market.worstSell > market.midpoint ||
        market.worstBuy < market.midpoint ||
        market.worstBuy >= PRICE_SCALE
      ) {
        throw new Error("stored hybrid prediction bounds are invalid");
      }
      views.set(item.key, Object.freeze({
        kind: "prediction_market",
        key: item.key,
        market,
      }));
      continue;
    }
    if (item.kind !== "spot") {
      throw new Error("stored hybrid reconstitution kind is invalid");
    }
    const decimals = Number(integer(item, "tokenDecimals"));
    const priceScale = integer(item, "priceScale");
    const midpoint = integer(item, "midpoint");
    let mint: PublicKey;
    try {
      mint = new PublicKey(item.tokenId);
    } catch {
      throw new Error("stored hybrid spot mint is invalid");
    }
    if (
      mint.equals(PublicKey.default) ||
      item.key !== spotKey(item.tokenId) ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 18 ||
      priceScale !== 10n ** BigInt(decimals) ||
      midpoint <= 0n
    ) {
      throw new Error("stored hybrid spot bounds are invalid");
    }
    views.set(item.key, Object.freeze({
      kind: "spot",
      key: item.key,
      tokenId: item.tokenId,
      tokenDecimals: decimals,
      observedAtMs: integer(item, "observedAtMs"),
      sourceHash: item.sourceHash,
      midpoint,
      priceScale,
    }));
  }
  const actual = [...views.keys()].sort();
  if (
    actual.length !== expectedKeys.length ||
    actual.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("stored hybrid reconstitution plan does not match the required assets");
  }
  return views;
}

function viewFor(book: OrderBook, maximumSlippageBps: number): MarketView {
  const bid = book.bids[0]?.priceUnits;
  const ask = book.asks[0]?.priceUnits;
  if (bid === undefined || ask === undefined || bid >= ask) throw new Error(`CTF token ${book.tokenId} has no executable two-sided book`);
  const midpoint = (bid + ask) / 2n;
  const slippage = BigInt(maximumSlippageBps);
  const worstBuy = divCeil(midpoint * (BPS + slippage), BPS);
  const worstSell = (midpoint * (BPS - slippage)) / BPS;
  if (worstSell <= 0n || worstBuy >= PRICE_SCALE) throw new Error(`slippage bound is invalid for CTF token ${book.tokenId}`);
  const conditionId = book.marketId.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(conditionId)) throw new Error("CLOB order book did not return a canonical condition ID");
  return Object.freeze({
    tokenId: book.tokenId,
    conditionId,
    negativeRisk: book.negativeRisk,
    minOrderSizeUnits: book.minOrderSizeUnits,
    observedAtMs: book.timestampMs,
    sourceHash: book.sourceHash,
    midpoint,
    worstBuy,
    worstSell,
  });
}

function marketPlanJson(views: ReadonlyMap<string, MarketView>, maximumSlippageBps: number): JsonValue {
  return {
    version: "alphabasket/reconstitution-market-plan-v1",
    maximumSlippageBps: maximumSlippageBps.toString(10),
    views: [...views.values()].sort((left, right) => left.tokenId.localeCompare(right.tokenId, "en")).map((view) => ({
      tokenId: view.tokenId,
      conditionId: view.conditionId,
      negativeRisk: view.negativeRisk,
      minOrderSizeUnits: view.minOrderSizeUnits.toString(10),
      observedAtMs: view.observedAtMs.toString(10),
      sourceHash: view.sourceHash,
      midpoint: view.midpoint.toString(10),
      worstBuy: view.worstBuy.toString(10),
      worstSell: view.worstSell.toString(10),
    })),
  };
}

function marketViewsFromJson(
  value: JsonValue,
  expectedTokens: readonly string[],
  maximumSlippageBps: number,
): ReadonlyMap<string, MarketView> {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("stored reconstitution market plan is invalid");
  const record = value as { readonly [key: string]: JsonValue };
  if (record.version !== "alphabasket/reconstitution-market-plan-v1" || record.maximumSlippageBps !== maximumSlippageBps.toString(10) || !Array.isArray(record.views)) {
    throw new Error("stored reconstitution market plan has an incompatible version or policy");
  }
  const views = new Map<string, MarketView>();
  for (const raw of record.views) {
    if (raw === null || Array.isArray(raw) || typeof raw !== "object") throw new Error("stored reconstitution market view is invalid");
    const item = raw as { readonly [key: string]: JsonValue };
    const integer = (name: string): bigint => {
      const field = item[name];
      if (typeof field !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(field)) throw new Error(`stored reconstitution ${name} is invalid`);
      return BigInt(field);
    };
    if (typeof item.tokenId !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(item.tokenId) ||
        typeof item.conditionId !== "string" || !/^0x[0-9a-f]{64}$/u.test(item.conditionId) ||
        typeof item.negativeRisk !== "boolean" || typeof item.sourceHash !== "string" || item.sourceHash.length === 0 || item.sourceHash.length > 512) {
      throw new Error("stored reconstitution market identity is invalid");
    }
    const view: MarketView = Object.freeze({
      tokenId: item.tokenId,
      conditionId: item.conditionId,
      negativeRisk: item.negativeRisk,
      minOrderSizeUnits: integer("minOrderSizeUnits"),
      observedAtMs: integer("observedAtMs"),
      sourceHash: item.sourceHash,
      midpoint: integer("midpoint"),
      worstBuy: integer("worstBuy"),
      worstSell: integer("worstSell"),
    });
    if (view.minOrderSizeUnits <= 0n || view.midpoint <= 0n || view.midpoint >= PRICE_SCALE ||
        view.worstSell <= 0n || view.worstSell > view.midpoint || view.worstBuy < view.midpoint || view.worstBuy >= PRICE_SCALE ||
        views.has(view.tokenId)) {
      throw new Error("stored reconstitution market bounds are invalid");
    }
    views.set(view.tokenId, view);
  }
  const actualTokens = [...views.keys()].sort();
  if (actualTokens.length !== expectedTokens.length || actualTokens.some((token, index) => token !== expectedTokens[index])) {
    throw new Error("stored reconstitution market plan does not match the required tokens");
  }
  return views;
}

function resultJson(result: ReconstitutionExecutionResult): JsonValue {
  return {
    executionHash: result.executionHash,
    orderIds: [...result.orderIds],
    ...(result.jupiterTransactions === undefined
      ? {}
      : { jupiterTransactions: [...result.jupiterTransactions] }),
    realizedPusdDeltaUnits: result.realizedPusdDeltaUnits.toString(10),
    ...(result.realizedUsdcDeltaUnits === undefined
      ? {}
      : {
          realizedUsdcDeltaUnits:
            result.realizedUsdcDeltaUnits.toString(10),
        }),
    executedAtMs: result.executedAtMs.toString(10),
  };
}

export interface HybridReconstitutionOptions {
  readonly jupiter: JupiterExecutionPort;
  readonly prices: JupiterPricePort;
  readonly tokens: JupiterTokenDirectoryPort;
  readonly usdcMint: PublicKey;
  readonly taker: PublicKey;
}

export class PolymarketReconstitutionExecutor implements ReconstitutionExecutionPort {
  public constructor(
    private readonly portfolio: BasketAttributedHoldingsPort,
    private readonly executions: LifecycleExternalExecutionStorePort,
    private readonly markets: ClobMarketDataPort,
    private readonly fak: FakExecutionPort,
    private readonly clock: ClockPort,
    private readonly walletCoordinator: WalletExecutionCoordinatorPort,
    private readonly walletId: string,
    private readonly executionGuard: FinancialExecutionGuardPort,
    private readonly maximumSlippageBps: number,
    private readonly faults: FaultInjectorPort = NOOP_FAULT_INJECTOR,
    private readonly hybrid?: HybridReconstitutionOptions,
  ) {
    if (walletId.length === 0 || walletId.length > 256) throw new RangeError("reconstitution wallet ID must contain 1-256 characters");
    if (!Number.isSafeInteger(maximumSlippageBps) || maximumSlippageBps < 1 || maximumSlippageBps > 2_000) {
      throw new RangeError("reconstitution slippage must be between 1 and 2000 bps");
    }
  }

  public async rebalance(request: {
    readonly operationId: string;
    readonly basket: import("@solana/web3.js").PublicKey;
    readonly previousCompositionVersion: number;
    readonly nextComposition: SignedReconstitution;
  }): Promise<ReconstitutionExecutionResult> {
    return this.walletCoordinator.execute(this.walletId, request.operationId, async (signal) => {
      if (signal.aborted) throw signal.reason;
      return this.rebalanceLocked(request, signal);
    });
  }

  private async rebalanceLocked(request: {
    readonly operationId: string;
    readonly basket: import("@solana/web3.js").PublicKey;
    readonly previousCompositionVersion: number;
    readonly nextComposition: SignedReconstitution;
  }, signal: AbortSignal): Promise<ReconstitutionExecutionResult> {
    const basketId = request.basket.toBase58();
    const hash = requestHash({ basket: basketId, previousCompositionVersion: request.previousCompositionVersion, nextComposition: request.nextComposition });
    const replay = await this.executions.prepare({
      operationId: request.operationId,
      requestHash: hash,
      kind: "reconstitution",
      basketId,
      now: this.clock.now(),
    });
    if (replay !== null) return executionResultFromJson(replay);
    if (request.nextComposition.nextCompositionVersion !== request.previousCompositionVersion + 1) throw new Error("reconstitution composition version is not sequential");
    const computedCompositionHash = compositionHash(request.nextComposition.items);
    if (!computedCompositionHash.equals(Buffer.from(request.nextComposition.compositionHash))) throw new Error("signed reconstitution composition hash is invalid");
    const state = await this.portfolio.loadBasketState(basketId);
    if (state.compositionVersion !== BigInt(request.previousCompositionVersion)) throw new Error("portfolio composition version is stale");
    const containsSpot =
      request.nextComposition.items.some((item) => "spot" in item.kind) ||
      state.holdings.some((holding) => holding.assetKind === "spot");
    if (containsSpot) {
      if (this.hybrid === undefined) {
        throw new Error("Jupiter reconstitution is not configured for this spot or mixed basket");
      }
      return this.rebalanceHybrid(
        request,
        hash,
        state,
        signal,
        this.hybrid,
      );
    }

    const targetByToken = new Map(request.nextComposition.items.map((item) => {
      if ("perp" in item.kind) {
        throw new Error(
          `basket item ${item.marketId} is a perpetual; perp reconstitution is ` +
            "not routed through this executor",
        );
      }
      if (!("predictionMarket" in item.kind)) throw new Error("unexpected spot target");
      const tokenId = tokenIdFromBytes(item.kind.predictionMarket.ctfTokenId);
      return [
        tokenId,
        { item, tokenId, outcome: item.kind.predictionMarket.outcome },
      ] as const;
    }));
    const tokens = [...new Set([...state.holdings.map((holding) => holding.tokenId), ...targetByToken.keys()])].sort();
    let storedPlan = await this.executions.loadPlan(request.operationId, hash);
    if (storedPlan === null) {
      const discovered = new Map<string, MarketView>();
      for (const tokenId of tokens) {
        if (signal.aborted) throw signal.reason;
        discovered.set(tokenId, viewFor(await this.markets.getOrderBook(tokenId), this.maximumSlippageBps));
      }
      storedPlan = await this.executions.putPlan({
        operationId: request.operationId,
        requestHash: hash,
        plan: marketPlanJson(discovered, this.maximumSlippageBps),
        now: this.clock.now(),
      });
    }
    const views = marketViewsFromJson(storedPlan, tokens, this.maximumSlippageBps);

    const grossNav = state.idlePusdUnits + state.holdings.reduce((sum, holding) => {
      const view = views.get(holding.tokenId);
      if (view === undefined) throw new Error(`missing market view for ${holding.tokenId}`);
      return sum + (holding.quantityUnits * view.midpoint) / PRICE_SCALE;
    }, 0n);
    await this.executionGuard.authorize({
      operationId: request.operationId,
      basketId,
      walletId: this.walletId,
      amountUnits: grossNav,
      now: this.clock.now(),
    });
    const targetValues = new Map<string, bigint>();
    for (const [tokenId, target] of targetByToken) targetValues.set(tokenId, (grossNav * BigInt(target.item.weightBps)) / BPS);

    const quantity = new Map(state.holdings.map((holding) => [holding.tokenId, holding.quantityUnits]));
    const originalByToken = new Map(state.holdings.map((holding) => [holding.tokenId, holding]));
    let idle = state.idlePusdUnits;
    const orders: FakOrderResult[] = [];
    let orderIndex = 0;

    for (const tokenId of [...quantity.keys()].sort()) {
      const currentUnits = quantity.get(tokenId) ?? 0n;
      const view = views.get(tokenId);
      if (currentUnits === 0n || view === undefined) continue;
      const currentValue = (currentUnits * view.midpoint) / PRICE_SCALE;
      const targetValue = targetValues.get(tokenId) ?? 0n;
      if (currentValue <= targetValue) continue;
      const amount = ((currentValue - targetValue) * PRICE_SCALE) / view.midpoint;
      if (amount < view.minOrderSizeUnits || amount === 0n) continue;
      if (signal.aborted) throw signal.reason;
      const order = await this.fak.executeFak({
        clientOrderId: `${request.operationId}:sell:${orderIndex.toString(10)}:${tokenId}`,
        tokenId,
        side: "sell",
        negativeRisk: view.negativeRisk,
        amountUnits: amount,
        worstPriceUnits: view.worstSell,
      });
      await this.faults.after("reconstitution.fak_order_executed", {
        operationId: request.operationId,
        metadata: { clientOrderId: order.clientOrderId, orderId: order.orderId },
      });
      if (order.side !== "sell" || order.tokenId !== tokenId || order.filledInputUnits > amount) throw new Error("invalid reconstitution sell fill");
      quantity.set(tokenId, currentUnits - order.filledInputUnits);
      idle += order.filledOutputUnits;
      orders.push(order);
      orderIndex += 1;
    }

    const deficits = new Map<string, bigint>();
    for (const tokenId of [...targetByToken.keys()].sort()) {
      const view = views.get(tokenId);
      if (view === undefined) throw new Error(`missing target market view for ${tokenId}`);
      const currentValue = ((quantity.get(tokenId) ?? 0n) * view.midpoint) / PRICE_SCALE;
      const deficit = (targetValues.get(tokenId) ?? 0n) - currentValue;
      if (deficit > 0n) deficits.set(tokenId, deficit);
    }
    let remainingDeficit = [...deficits.values()].reduce((sum, value) => sum + value, 0n);
    for (const tokenId of [...deficits.keys()].sort()) {
      const deficit = deficits.get(tokenId) ?? 0n;
      const view = views.get(tokenId);
      if (deficit === 0n || remainingDeficit === 0n || idle === 0n || view === undefined) continue;
      const allocation = tokenId === [...deficits.keys()].sort().at(-1)
        ? idle < deficit ? idle : deficit
        : (idle * deficit) / remainingDeficit;
      remainingDeficit -= deficit;
      const expectedShares = (allocation * PRICE_SCALE) / view.worstBuy;
      if (allocation === 0n || expectedShares < view.minOrderSizeUnits) continue;
      if (signal.aborted) throw signal.reason;
      const order = await this.fak.executeFak({
        clientOrderId: `${request.operationId}:buy:${orderIndex.toString(10)}:${tokenId}`,
        tokenId,
        side: "buy",
        negativeRisk: view.negativeRisk,
        amountUnits: allocation,
        worstPriceUnits: view.worstBuy,
      });
      await this.faults.after("reconstitution.fak_order_executed", {
        operationId: request.operationId,
        metadata: { clientOrderId: order.clientOrderId, orderId: order.orderId },
      });
      if (order.side !== "buy" || order.tokenId !== tokenId || order.filledInputUnits > allocation || order.filledInputUnits > idle) {
        throw new Error("invalid reconstitution buy fill");
      }
      idle -= order.filledInputUnits;
      quantity.set(tokenId, (quantity.get(tokenId) ?? 0n) + order.filledOutputUnits);
      orders.push(order);
      orderIndex += 1;
    }

    const nowMs = BigInt(this.clock.now().getTime());
    const nextHoldings: BasketAttributedHolding[] = [];
    for (const tokenId of [...quantity.keys()].sort()) {
      const quantityUnits = quantity.get(tokenId) ?? 0n;
      if (quantityUnits === 0n) continue;
      const view = views.get(tokenId);
      if (view === undefined) throw new Error(`missing final market view for ${tokenId}`);
      const target = targetByToken.get(tokenId);
      const original = originalByToken.get(tokenId);
      const conditionId = view.conditionId;
      if (original?.conditionId !== undefined && original.conditionId !== conditionId) throw new Error("stored holding condition does not match CLOB metadata");
      nextHoldings.push(Object.freeze({
        marketId: target?.item.marketId ?? original?.marketId ?? conditionId,
        tokenId,
        conditionId,
        negativeRisk: view.negativeRisk,
        outcome: target === undefined ? original?.outcome ?? "unknown" : String(target.outcome),
        quantityUnits,
        markPriceUnits: view.midpoint,
        priceScale: PRICE_SCALE,
        markObservedAtMs: view.observedAtMs,
        markSourceHash: view.sourceHash,
        markCondition: "fresh",
      }));
    }
    const executedAtMs = orders.reduce((latest, order) => order.executedAtMs > latest ? order.executedAtMs : latest, nowMs);
    const executionHash = createHash("sha256").update(JSON.stringify([
      "ALPHABASKET_RECONSTITUTION_RESULT_V1",
      hash,
      idle.toString(10),
      nextHoldings.map((holding) => [holding.tokenId, holding.quantityUnits.toString(10)]),
      orders.map((order) => [order.clientOrderId, order.orderId, order.filledInputUnits.toString(10), order.filledOutputUnits.toString(10)]),
    ]), "utf8").digest("hex");
    const result: ReconstitutionExecutionResult = Object.freeze({
      executionHash,
      orderIds: Object.freeze(orders.map((order) => order.orderId)),
      realizedPusdDeltaUnits: idle - state.idlePusdUnits,
      executedAtMs,
    });
    if (signal.aborted) throw signal.reason;
    const committed = await this.executions.commit({
      operationId: request.operationId,
      requestHash: hash,
      basketId,
      expectedLedgerVersion: state.ledgerVersion,
      nextCompositionVersion: BigInt(request.nextComposition.nextCompositionVersion),
      nextCompositionHash: Buffer.from(request.nextComposition.compositionHash).toString("hex"),
      idlePusdUnits: idle,
      holdings: nextHoldings,
      result: resultJson(result),
      now: this.clock.now(),
    });
    return executionResultFromJson(committed);
  }

  private async rebalanceHybrid(
    request: {
      readonly operationId: string;
      readonly basket: PublicKey;
      readonly previousCompositionVersion: number;
      readonly nextComposition: SignedReconstitution;
    },
    hash: string,
    state: BasketAttributedState,
    signal: AbortSignal,
    hybrid: HybridReconstitutionOptions,
  ): Promise<ReconstitutionExecutionResult> {
    const basketId = request.basket.toBase58();
    const targetByKey = new Map<string, Readonly<{
      key: string;
      tokenId: string;
      item: (typeof request.nextComposition.items)[number];
      kind: "prediction_market" | "spot";
      outcome: string;
    }>>();
    for (const item of request.nextComposition.items) {
      if ("predictionMarket" in item.kind) {
        const tokenId = tokenIdFromBytes(
          item.kind.predictionMarket.ctfTokenId,
        );
        targetByKey.set(
          predictionKey(tokenId),
          Object.freeze({
            key: predictionKey(tokenId),
            tokenId,
            item,
            kind: "prediction_market" as const,
            outcome: String(item.kind.predictionMarket.outcome),
          }),
        );
        continue;
      }
      if ("perp" in item.kind) {
        // Perpetual legs are executed through the Phoenix gateway, not through
        // the Polymarket/Jupiter planner below: they are opened and closed with
        // `complete_phoenix_trade` against an isolated Phoenix subaccount and
        // hold no CTF token or SPL mint this planner could rebalance.
        //
        // Failing loudly rather than skipping. A silent skip would report a
        // successful reconstitution while leaving every perp leg at its old
        // weight, which is worse than not reconstituting at all.
        throw new Error(
          `basket ${basketId} contains a perpetual item (${item.marketId}); ` +
            "perp reconstitution is not routed through this executor",
        );
      }
      const tokenId = item.kind.spot.tokenMint.toBase58();
      targetByKey.set(
        spotKey(tokenId),
        Object.freeze({
          key: spotKey(tokenId),
          tokenId,
          item,
          kind: "spot" as const,
          outcome: "spot",
        }),
      );
    }
    const originalByKey = new Map(state.holdings.map((holding) => {
      const kind = holding.assetKind ?? "prediction_market";
      return [
        kind === "spot"
          ? spotKey(holding.tokenId)
          : predictionKey(holding.tokenId),
        holding,
      ] as const;
    }));
    const keys = [...new Set([
      ...targetByKey.keys(),
      ...originalByKey.keys(),
    ])].sort();
    let storedPlan = await this.executions.loadPlan(
      request.operationId,
      hash,
    );
    if (storedPlan === null) {
      const discovered = new Map<string, HybridAssetView>();
      const spotMints = keys
        .filter((key) => key.startsWith("spot:"))
        .map((key) => new PublicKey(key.slice("spot:".length)));
      const spotPrices = spotMints.length === 0
        ? []
        : await hybrid.prices.getUsdcPrices(
            spotMints,
            hybrid.usdcMint,
          );
      const spotPriceByMint = new Map(
        spotPrices.map((price) => [price.mint.toBase58(), price]),
      );
      for (const key of keys) {
        if (signal.aborted) throw signal.reason;
        if (key.startsWith("prediction_market:")) {
          const tokenId = key.slice("prediction_market:".length);
          discovered.set(key, Object.freeze({
            kind: "prediction_market",
            key,
            market: viewFor(
              await this.markets.getOrderBook(tokenId),
              this.maximumSlippageBps,
            ),
          }));
          continue;
        }
        const tokenId = key.slice("spot:".length);
        const mint = new PublicKey(tokenId);
        const metadata = await hybrid.tokens.requireVerified(mint);
        const price = spotPriceByMint.get(tokenId);
        if (price === undefined) {
          throw new Error(`Jupiter price is missing for ${tokenId}`);
        }
        const original = originalByKey.get(key);
        if (
          original?.tokenDecimals !== undefined &&
          original.tokenDecimals !== metadata.decimals
        ) {
          throw new Error(`Jupiter decimals changed for attributed spot mint ${tokenId}`);
        }
        discovered.set(key, Object.freeze({
          kind: "spot",
          key,
          tokenId,
          tokenDecimals: metadata.decimals,
          observedAtMs: price.observedAtMs,
          sourceHash: price.sourceHash,
          midpoint: price.priceUsdcUnits,
          priceScale: 10n ** BigInt(metadata.decimals),
        }));
      }
      storedPlan = await this.executions.putPlan({
        operationId: request.operationId,
        requestHash: hash,
        plan: hybridPlanJson(
          discovered,
          this.maximumSlippageBps,
        ),
        now: this.clock.now(),
      });
    }
    const views = hybridViewsFromJson(
      storedPlan,
      keys,
      this.maximumSlippageBps,
    );
    const grossNav =
      state.idlePusdUnits +
      (state.idleUsdcUnits ?? 0n) +
      [...originalByKey.entries()].reduce((sum, [key, holding]) => {
        const view = views.get(key);
        if (view === undefined) {
          throw new Error(`missing hybrid market view for ${key}`);
        }
        return sum + hybridValue(holding.quantityUnits, view);
      }, 0n);
    await this.executionGuard.authorize({
      operationId: request.operationId,
      basketId,
      walletId: this.walletId,
      amountUnits: grossNav,
      now: this.clock.now(),
    });
    const targetValues = new Map(
      [...targetByKey].map(([key, target]) => [
        key,
        (grossNav * BigInt(target.item.weightBps)) / BPS,
      ]),
    );
    const quantity = new Map(
      [...originalByKey].map(([key, holding]) => [
        key,
        holding.quantityUnits,
      ]),
    );
    let idlePusd = state.idlePusdUnits;
    let idleUsdc = state.idleUsdcUnits ?? 0n;
    const orders: FakOrderResult[] = [];
    const swaps: Awaited<
      ReturnType<JupiterExecutionPort["executeExactIn"]>
    >[] = [];
    let executionIndex = 0;

    for (const key of [...quantity.keys()].sort()) {
      const currentUnits = quantity.get(key) ?? 0n;
      const view = views.get(key);
      if (currentUnits === 0n || view === undefined) continue;
      const currentValue = hybridValue(currentUnits, view);
      const targetValue = targetValues.get(key) ?? 0n;
      if (currentValue <= targetValue) continue;
      const amount = hybridQuantity(
        currentValue - targetValue,
        view,
      );
      if (amount === 0n) continue;
      if (signal.aborted) throw signal.reason;
      if (view.kind === "prediction_market") {
        if (amount < view.market.minOrderSizeUnits) continue;
        const order = await this.fak.executeFak({
          clientOrderId:
            `${request.operationId}:reconstitution:sell:${executionIndex.toString(10)}:${view.market.tokenId}`,
          tokenId: view.market.tokenId,
          side: "sell",
          negativeRisk: view.market.negativeRisk,
          amountUnits: amount,
          worstPriceUnits: view.market.worstSell,
        });
        await this.faults.after(
          "reconstitution.fak_order_executed",
          {
            operationId: request.operationId,
            metadata: {
              clientOrderId: order.clientOrderId,
              orderId: order.orderId,
            },
          },
        );
        if (
          order.side !== "sell" ||
          order.tokenId !== view.market.tokenId ||
          order.filledInputUnits > amount ||
          order.filledInputUnits > currentUnits
        ) {
          throw new Error("invalid hybrid reconstitution prediction sell");
        }
        quantity.set(key, currentUnits - order.filledInputUnits);
        idlePusd += order.filledOutputUnits;
        orders.push(order);
      } else {
        const swap = await hybrid.jupiter.executeExactIn({
          idempotencyKey:
            `${request.operationId}:reconstitution:sell:${executionIndex.toString(10)}`,
          inputMint: new PublicKey(view.tokenId),
          outputMint: hybrid.usdcMint,
          inputAmountUnits: amount,
          slippageBps: this.maximumSlippageBps,
          taker: hybrid.taker,
        });
        await this.faults.after(
          "reconstitution.jupiter_swap_executed",
          {
            operationId: request.operationId,
            metadata: {
              transactionSignature: swap.transactionSignature,
            },
          },
        );
        if (
          !swap.inputMint.equals(new PublicKey(view.tokenId)) ||
          !swap.outputMint.equals(hybrid.usdcMint) ||
          swap.requestedInputUnits !== amount ||
          swap.filledInputUnits <= 0n ||
          swap.filledInputUnits > amount ||
          swap.filledInputUnits > currentUnits
        ) {
          throw new Error("invalid hybrid reconstitution Jupiter sell");
        }
        quantity.set(key, currentUnits - swap.filledInputUnits);
        idleUsdc += swap.filledOutputUnits;
        swaps.push(swap);
      }
      executionIndex += 1;
    }

    for (const key of [...targetByKey.keys()].sort()) {
      const view = views.get(key);
      if (view === undefined) {
        throw new Error(`missing target hybrid view for ${key}`);
      }
      const currentValue = hybridValue(
        quantity.get(key) ?? 0n,
        view,
      );
      const deficit = (targetValues.get(key) ?? 0n) - currentValue;
      if (deficit <= 0n) continue;
      if (signal.aborted) throw signal.reason;
      if (view.kind === "prediction_market") {
        const allocation = idlePusd < deficit
          ? idlePusd
          : deficit;
        const expectedShares =
          (allocation * PRICE_SCALE) /
          view.market.worstBuy;
        if (
          allocation === 0n ||
          expectedShares < view.market.minOrderSizeUnits
        ) {
          continue;
        }
        const order = await this.fak.executeFak({
          clientOrderId:
            `${request.operationId}:reconstitution:buy:${executionIndex.toString(10)}:${view.market.tokenId}`,
          tokenId: view.market.tokenId,
          side: "buy",
          negativeRisk: view.market.negativeRisk,
          amountUnits: allocation,
          worstPriceUnits: view.market.worstBuy,
        });
        await this.faults.after(
          "reconstitution.fak_order_executed",
          {
            operationId: request.operationId,
            metadata: {
              clientOrderId: order.clientOrderId,
              orderId: order.orderId,
            },
          },
        );
        if (
          order.side !== "buy" ||
          order.tokenId !== view.market.tokenId ||
          order.filledInputUnits > allocation ||
          order.filledInputUnits > idlePusd
        ) {
          throw new Error("invalid hybrid reconstitution prediction buy");
        }
        idlePusd -= order.filledInputUnits;
        quantity.set(
          key,
          (quantity.get(key) ?? 0n) + order.filledOutputUnits,
        );
        orders.push(order);
      } else {
        const allocation = idleUsdc < deficit
          ? idleUsdc
          : deficit;
        if (allocation === 0n) continue;
        const swap = await hybrid.jupiter.executeExactIn({
          idempotencyKey:
            `${request.operationId}:reconstitution:buy:${executionIndex.toString(10)}`,
          inputMint: hybrid.usdcMint,
          outputMint: new PublicKey(view.tokenId),
          inputAmountUnits: allocation,
          slippageBps: this.maximumSlippageBps,
          taker: hybrid.taker,
        });
        await this.faults.after(
          "reconstitution.jupiter_swap_executed",
          {
            operationId: request.operationId,
            metadata: {
              transactionSignature: swap.transactionSignature,
            },
          },
        );
        if (
          !swap.inputMint.equals(hybrid.usdcMint) ||
          !swap.outputMint.equals(new PublicKey(view.tokenId)) ||
          swap.requestedInputUnits !== allocation ||
          swap.filledInputUnits <= 0n ||
          swap.filledInputUnits > allocation ||
          swap.filledInputUnits > idleUsdc
        ) {
          throw new Error("invalid hybrid reconstitution Jupiter buy");
        }
        idleUsdc -= swap.filledInputUnits;
        quantity.set(
          key,
          (quantity.get(key) ?? 0n) + swap.filledOutputUnits,
        );
        swaps.push(swap);
      }
      executionIndex += 1;
    }

    const nextHoldings: BasketAttributedHolding[] = [];
    for (const key of [...quantity.keys()].sort()) {
      const quantityUnits = quantity.get(key) ?? 0n;
      if (quantityUnits === 0n) continue;
      const view = views.get(key);
      if (view === undefined) {
        throw new Error(`missing final hybrid view for ${key}`);
      }
      const target = targetByKey.get(key);
      const original = originalByKey.get(key);
      if (view.kind === "prediction_market") {
        if (
          original?.conditionId !== undefined &&
          original.conditionId !== view.market.conditionId
        ) {
          throw new Error("stored holding condition does not match CLOB metadata");
        }
        nextHoldings.push(Object.freeze({
          assetKind: "prediction_market",
          marketId:
            target?.item.marketId ??
            original?.marketId ??
            view.market.conditionId,
          tokenId: view.market.tokenId,
          conditionId: view.market.conditionId,
          negativeRisk: view.market.negativeRisk,
          outcome: target?.outcome ?? original?.outcome ?? "unknown",
          quantityUnits,
          markPriceUnits: view.market.midpoint,
          priceScale: PRICE_SCALE,
          markObservedAtMs: view.market.observedAtMs,
          markSourceHash: view.market.sourceHash,
          markCondition: "fresh",
        }));
      } else {
        nextHoldings.push(Object.freeze({
          assetKind: "spot",
          marketId:
            target?.item.marketId ??
            original?.marketId ??
            `jupiter:${view.tokenId}`,
          tokenId: view.tokenId,
          outcome: target?.outcome ?? original?.outcome ?? "spot",
          quantityUnits,
          markPriceUnits: view.midpoint,
          priceScale: view.priceScale,
          tokenDecimals: view.tokenDecimals,
          markObservedAtMs: view.observedAtMs,
          markSourceHash: view.sourceHash,
          markCondition: "fresh",
        }));
      }
    }
    const nowMs = BigInt(this.clock.now().getTime());
    const executedAtMs = [
      ...orders.map((order) => order.executedAtMs),
      ...swaps.map((swap) => swap.executedAtMs),
    ].reduce(
      (latest, observed) => observed > latest ? observed : latest,
      nowMs,
    );
    const executionHash = createHash("sha256").update(JSON.stringify([
      "ALPHABASKET_RECONSTITUTION_RESULT_V2",
      hash,
      idlePusd.toString(10),
      idleUsdc.toString(10),
      nextHoldings.map((holding) => [
        holding.assetKind,
        holding.tokenId,
        holding.quantityUnits.toString(10),
      ]),
      orders.map((order) => [
        order.clientOrderId,
        order.orderId,
        order.filledInputUnits.toString(10),
        order.filledOutputUnits.toString(10),
      ]),
      swaps.map((swap) => [
        swap.transactionSignature,
        swap.inputMint.toBase58(),
        swap.outputMint.toBase58(),
        swap.filledInputUnits.toString(10),
        swap.filledOutputUnits.toString(10),
      ]),
    ]), "utf8").digest("hex");
    const result: ReconstitutionExecutionResult = Object.freeze({
      executionHash,
      orderIds: Object.freeze(
        orders.map((order) => order.orderId),
      ),
      jupiterTransactions: Object.freeze(
        swaps.map((swap) => swap.transactionSignature),
      ),
      realizedPusdDeltaUnits:
        idlePusd - state.idlePusdUnits,
      realizedUsdcDeltaUnits:
        idleUsdc - (state.idleUsdcUnits ?? 0n),
      executedAtMs,
    });
    if (signal.aborted) throw signal.reason;
    const committed = await this.executions.commit({
      operationId: request.operationId,
      requestHash: hash,
      basketId,
      expectedLedgerVersion: state.ledgerVersion,
      nextCompositionVersion:
        BigInt(request.nextComposition.nextCompositionVersion),
      nextCompositionHash:
        Buffer.from(request.nextComposition.compositionHash).toString("hex"),
      idlePusdUnits: idlePusd,
      idleUsdcUnits: idleUsdc,
      holdings: nextHoldings,
      result: resultJson(result),
      now: this.clock.now(),
    });
    return executionResultFromJson(committed);
  }
}
