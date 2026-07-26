import { createHash } from "node:crypto";

import type { FakExecutionPort, FakOrderResult } from "../execution/types.js";
import { compositionHash } from "../contract/composition.js";
import type { BasketAttributedHolding, BasketAttributedHoldingsPort } from "../nav/types.js";
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
  const realized = record.realizedPusdDeltaUnits;
  const executedAt = record.executedAtMs;
  if (typeof executionHash !== "string" || !/^[0-9a-f]{64}$/u.test(executionHash) ||
      !Array.isArray(orderIds) || !orderIds.every((item) => typeof item === "string") ||
      typeof realized !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(realized) ||
      typeof executedAt !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(executedAt)) {
    throw new Error("stored reconstitution result is incomplete");
  }
  return Object.freeze({
    executionHash,
    orderIds: Object.freeze(orderIds as string[]),
    realizedPusdDeltaUnits: BigInt(realized),
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
    realizedPusdDeltaUnits: result.realizedPusdDeltaUnits.toString(10),
    executedAtMs: result.executedAtMs.toString(10),
  };
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

    const targetByToken = new Map(request.nextComposition.items.map((item) => {
      if (!("predictionMarket" in item.kind)) {
        throw new Error(
          "Polymarket reconstitution executor cannot execute Jupiter spot legs",
        );
      }
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
}
