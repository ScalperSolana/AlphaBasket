import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

import type { BasketAttributedHolding, BasketAttributedState } from "../src/nav/index.js";
import type { JsonValue } from "../src/persistence/index.js";
import {
  PolymarketPositionsRest,
  PolymarketRelayerRest,
  JsonHttpClient,
  redeemPositionsCalldata,
  type PolymarketRelayerEnvelopeSignerPort,
} from "../src/polymarket/index.js";
import {
  PolymarketReconstitutionExecutor,
  PolymarketResolutionExecutor,
  validateSolanaLifecycleMessage,
  type ConditionRedemptionRecord,
  type ConditionRedemptionResult,
  type ConditionRedemptionStorePort,
  type LifecycleExternalExecutionStorePort,
} from "../src/lifecycle/index.js";
import { FailOnceFaultInjector } from "../src/resilience/index.js";

const basket = new PublicKey(new Uint8Array(32).fill(41));
const condition = `0x${"11".repeat(32)}`;
const oldHash = "22".repeat(32);
const now = new Date(2_000_000_000_000);
const coordinator = Object.freeze({
  execute: async <Result>(
    _walletId: string,
    _operationId: string,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> => operation(new AbortController().signal),
});
const executionGuard = Object.freeze({ authorize: async () => undefined });

class MemoryExecutionStore implements LifecycleExternalExecutionStorePort {
  public result: JsonValue | null = null;
  public plan: JsonValue | null = null;
  public holdings: readonly BasketAttributedHolding[] = [];
  public idle = 0n;
  public idleUsdc = 0n;
  public identity: { operationId: string; requestHash: string } | undefined;

  public async prepare(request: { operationId: string; requestHash: string }): Promise<JsonValue | null> {
    if (this.identity !== undefined && (this.identity.operationId !== request.operationId || this.identity.requestHash !== request.requestHash)) {
      throw new Error("identity mismatch");
    }
    this.identity = request;
    return this.result;
  }

  public async loadPlan(operationId: string, requestHash: string): Promise<JsonValue | null> {
    if (this.identity?.operationId !== operationId || this.identity.requestHash !== requestHash) throw new Error("plan identity mismatch");
    return this.plan;
  }

  public async putPlan(request: { operationId: string; requestHash: string; plan: JsonValue }): Promise<JsonValue> {
    if (this.identity?.operationId !== request.operationId || this.identity.requestHash !== request.requestHash) throw new Error("plan identity mismatch");
    this.plan ??= request.plan;
    return this.plan;
  }

  public async commit(request: {
    result: JsonValue;
    holdings: readonly BasketAttributedHolding[];
    idlePusdUnits: bigint;
    idleUsdcUnits?: bigint;
  }): Promise<JsonValue> {
    if (this.result === null) {
      this.result = request.result;
      this.holdings = request.holdings;
      this.idle = request.idlePusdUnits;
      this.idleUsdc = request.idleUsdcUnits ?? 0n;
    }
    return this.result;
  }
}

describe("Polymarket lifecycle production adapters", () => {
  it("encodes the documented collateral-adapter redemption call", () => {
    const calldata = redeemPositionsCalldata(condition);
    assert.equal(calldata.slice(0, 10), "0x01b7037c");
    assert.equal(calldata.length, 2 + 8 + (64 * 7));
    assert.ok(calldata.includes(condition.slice(2)));
  });

  it("loads redeemable positions and confirms a signed relayer submission", async () => {
    const wallet = `0x${"33".repeat(20)}`;
    let transactionPolls = 0;
    const fetch = async (input: string, init: RequestInit): Promise<Response> => {
      if (input.includes("/positions?")) return new Response(JSON.stringify([{
        proxyWallet: wallet,
        asset: "1",
        conditionId: condition,
        size: 12.5,
        curPrice: 1,
        redeemable: true,
        outcome: "Yes",
        outcomeIndex: 0,
        negativeRisk: false,
      }]), { status: 200 });
      if (input.endsWith("/submit")) {
        assert.equal(init.method, "POST");
        return new Response(JSON.stringify({ transactionID: "relay-1", state: "STATE_NEW" }), { status: 200 });
      }
      if (input.includes("/transaction?")) {
        transactionPolls += 1;
        return new Response(JSON.stringify({
          transactionID: "relay-1",
          transactionHash: transactionPolls === 1 ? "" : `0x${"44".repeat(32)}`,
          from: `0x${"55".repeat(20)}`,
          to: `0x${"66".repeat(20)}`,
          proxyAddress: wallet,
          data: "0x01",
          nonce: "1",
          state: transactionPolls === 1 ? "STATE_EXECUTED" : "STATE_CONFIRMED",
          type: "SAFE",
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    const http = new JsonHttpClient({ fetch, timeoutMs: 1_000 });
    const positions = await new PolymarketPositionsRest(http).listRedeemable(wallet);
    assert.equal(positions[0]?.sizeUnits, 12_500_000n);
    const signer: PolymarketRelayerEnvelopeSignerPort = {
      prepare: async () => ({
        requestHash: "77".repeat(32),
        submission: {
          from: `0x${"55".repeat(20)}`,
          to: `0x${"66".repeat(20)}`,
          proxyWallet: wallet,
          data: "0x01",
          nonce: "1",
          signature: "0x01",
          signatureParams: {
            gasPrice: "0", operation: "0", safeTxnGas: "0", baseGas: "0",
            gasToken: `0x${"00".repeat(20)}`, refundReceiver: `0x${"00".repeat(20)}`,
          },
          type: "SAFE",
        },
        authenticationHeaders: { RELAYER_API_KEY: "key" },
      }),
    };
    const relayer = new PolymarketRelayerRest(http, signer, { sleep: async () => undefined }, { pollIntervalMs: 250, maximumPolls: 3 });
    const result = await relayer.execute({
      operationId: "redeem-1",
      proxyWallet: wallet,
      transactions: [{ to: `0x${"66".repeat(20)}`, data: "0x01", value: "0" }],
      description: "redeem",
    });
    assert.equal(result.transactionHash, `0x${"44".repeat(32)}`);
    assert.equal(transactionPolls, 2);
  });

  it("paginates shared-wallet positions and rejects duplicate token rows", async () => {
    const wallet = `0x${"34".repeat(20)}`;
    const row = (asset: string) => ({
      proxyWallet: wallet,
      asset,
      conditionId: condition,
      size: "1",
      curPrice: "1",
      redeemable: true,
      outcome: "Yes",
      outcomeIndex: 0,
      negativeRisk: false,
    });
    let calls = 0;
    const paginated = new PolymarketPositionsRest(new JsonHttpClient({
      timeoutMs: 1_000,
      fetch: async (input) => {
        calls += 1;
        const offset = new URL(input).searchParams.get("offset");
        const rows = offset === "0"
          ? Array.from({ length: 500 }, (_, index) => row((index + 1).toString(10)))
          : [row("501")];
        return new Response(JSON.stringify(rows), { status: 200 });
      },
    }));
    const positions = await paginated.listRedeemable(wallet);
    assert.equal(positions.length, 501);
    assert.equal(calls, 2);

    const duplicate = new PolymarketPositionsRest(new JsonHttpClient({
      timeoutMs: 1_000,
      fetch: async (input) => {
        const offset = new URL(input).searchParams.get("offset");
        const rows = offset === "0"
          ? Array.from({ length: 500 }, (_, index) => row((index + 1).toString(10)))
          : [row("500")];
        return new Response(JSON.stringify(rows), { status: 200 });
      },
    }));
    await assert.rejects(duplicate.listRedeemable(wallet), /duplicate token/u);
  });

  it("rejects a relayer poll result that differs from the signed envelope", async () => {
    const wallet = `0x${"35".repeat(20)}`;
    const from = `0x${"55".repeat(20)}`;
    const to = `0x${"66".repeat(20)}`;
    const signer: PolymarketRelayerEnvelopeSignerPort = {
      prepare: async () => ({
        requestHash: "77".repeat(32),
        submission: {
          from,
          to,
          proxyWallet: wallet,
          data: "0x01",
          nonce: "1",
          signature: "0x01",
          signatureParams: {
            gasPrice: "0", operation: "0", safeTxnGas: "0", baseGas: "0",
            gasToken: `0x${"00".repeat(20)}`, refundReceiver: `0x${"00".repeat(20)}`,
          },
          type: "SAFE",
        },
        authenticationHeaders: { authorization: "test" },
      }),
    };
    const relayer = new PolymarketRelayerRest(new JsonHttpClient({
      timeoutMs: 1_000,
      fetch: async (input) => input.endsWith("/submit")
        ? new Response(JSON.stringify({ transactionID: "relay-mismatch", state: "STATE_NEW" }), { status: 200 })
        : new Response(JSON.stringify({
          transactionID: "relay-mismatch",
          transactionHash: `0x${"44".repeat(32)}`,
          from,
          to: `0x${"67".repeat(20)}`,
          proxyAddress: wallet,
          data: "0x01",
          nonce: "1",
          state: "STATE_CONFIRMED",
          type: "SAFE",
        }), { status: 200 }),
    }), signer, { sleep: async () => undefined }, { pollIntervalMs: 250, maximumPolls: 1 });
    await assert.rejects(relayer.execute({
      operationId: "relayer-mismatch",
      proxyWallet: wallet,
      transactions: [{ to, data: "0x01", value: "0" }],
      description: "mismatch",
    }), /does not match the signed envelope/u);
  });

  it("executes partial-fill-compatible reconstitution and commits actual holdings", async () => {
    const bytes32 = (value: number): Uint8Array => {
      const result = new Uint8Array(32);
      result[31] = value;
      return result;
    };
    const state: BasketAttributedState = {
      basketId: basket.toBase58(), ledgerVersion: "ledger-1", compositionVersion: 1n,
      compositionHash: oldHash, idlePusdUnits: 60_000_000n,
      holdings: [{
        marketId: "m1", tokenId: "1", conditionId: condition, negativeRisk: false, outcome: "1",
        quantityUnits: 80_000_000n, markPriceUnits: 500_000n, priceScale: 1_000_000n,
        markObservedAtMs: BigInt(now.getTime()), markSourceHash: "old", markCondition: "fresh",
      }],
    };
    const items = [
      { marketId: "m1", kind: { predictionMarket: { outcome: 1, ctfTokenId: bytes32(1) } }, weightBps: 3_000 },
      { marketId: "m2", kind: { predictionMarket: { outcome: 0, ctfTokenId: bytes32(2) } }, weightBps: 3_000 },
      { marketId: "m3", kind: { predictionMarket: { outcome: 1, ctfTokenId: bytes32(3) } }, weightBps: 2_000 },
      { marketId: "m4", kind: { predictionMarket: { outcome: 0, ctfTokenId: bytes32(4) } }, weightBps: 2_000 },
    ] as const;
    const compositionHash = (await import("../src/contract/composition.js")).compositionHash(items);
    const eligibleMarkets = items.map((item) => ({
      marketId: item.marketId,
      outcome: item.kind.predictionMarket.outcome,
      ctfTokenId: item.kind.predictionMarket.ctfTokenId,
    }));
    const eligibilityHash = (await import("../src/contract/composition.js")).eligibilityHash(eligibleMarkets);
    const store = new MemoryExecutionStore();
    const orders = new Map<string, string>();
    let marketCalls = 0;
    const executor = new PolymarketReconstitutionExecutor(
      { loadBasketState: async () => state },
      store,
      {
        getMidpoint: async () => 500_000n,
        getOrderBook: async (tokenId) => {
          marketCalls += 1;
          return {
            marketId: tokenId === "1" ? condition : `0x${tokenId.repeat(64)}`,
            tokenId, timestampMs: BigInt(now.getTime()),
            bids: [{ priceUnits: 490_000n, sizeUnits: 1_000_000_000n }],
            asks: [{ priceUnits: 510_000n, sizeUnits: 1_000_000_000n }],
            minOrderSizeUnits: 1n, tickSizeUnits: 10_000n, negativeRisk: false, sourceHash: `book-${tokenId}`,
          };
        },
      },
      { executeFak: async (request) => {
        const orderId = orders.get(request.clientOrderId) ?? `order-${orders.size.toString(10)}`;
        orders.set(request.clientOrderId, orderId);
        return {
          clientOrderId: request.clientOrderId, orderId, tokenId: request.tokenId, side: request.side,
          requestedAmountUnits: request.amountUnits, filledInputUnits: request.amountUnits,
          filledOutputUnits: (request.amountUnits * 1_000_000n) / request.worstPriceUnits,
          averagePriceUnits: request.worstPriceUnits, status: "matched", transactionHashes: [], tradeIds: [],
          executedAtMs: BigInt(now.getTime()),
        };
      } },
      { now: () => now },
      coordinator,
      "wallet-reconstitution",
      executionGuard,
      200,
      new FailOnceFaultInjector(["reconstitution.fak_order_executed"]),
    );
    const authorization = {
      basket, basketId: new Uint8Array(32).fill(1), nextCompositionVersion: 2,
      compositionHash, eligibilityHash, eligibilityNonce: 1n, eligibleMarkets,
      items, compositionNonce: 2n, compositionExpirySeconds: 2_000_000_100n,
      encodedMessage: new Uint8Array([1]), composerPublicKey: new Uint8Array(32).fill(2), composerSignature: new Uint8Array(64).fill(3),
    } as const;
    const reconstitutionRequest = { operationId: "recon-1", basket, previousCompositionVersion: 1, nextComposition: authorization } as const;
    await assert.rejects(executor.rebalance(reconstitutionRequest), /fault injected/u);
    const first = await executor.rebalance(reconstitutionRequest);
    const replay = await executor.rebalance(reconstitutionRequest);
    assert.equal(first.executionHash, replay.executionHash);
    // Reducing the retained m1 weight from 40% to 30% adds one sell before
    // the three target-market buys.
    assert.equal(orders.size, 4);
    assert.equal(marketCalls, 4);
    assert.equal(store.holdings.length, 4);
    // Worst-price bounded buys intentionally leave the unspent pUSD attributed
    // to the basket instead of forcing a final trade beyond the target.
    assert.equal(store.idle, 8_804_665n);
  });

  it("reconstitutes mixed baskets with replay-safe Jupiter spot legs", async () => {
    const bytes32 = (value: number): Uint8Array => {
      const result = new Uint8Array(32);
      result[31] = value;
      return result;
    };
    const spotA = new PublicKey(new Uint8Array(32).fill(61));
    const spotB = new PublicKey(new Uint8Array(32).fill(62));
    const spotC = new PublicKey(new Uint8Array(32).fill(63));
    const spotRemoved = new PublicKey(new Uint8Array(32).fill(64));
    const state: BasketAttributedState = {
      basketId: basket.toBase58(),
      ledgerVersion: "ledger-hybrid-1",
      compositionVersion: 1n,
      compositionHash: oldHash,
      idlePusdUnits: 40_000_000n,
      idleUsdcUnits: 30_000_000n,
      holdings: [
        {
          assetKind: "prediction_market",
          marketId: "m1",
          tokenId: "1",
          conditionId: condition,
          negativeRisk: false,
          outcome: "1",
          quantityUnits: 20_000_000n,
          markPriceUnits: 500_000n,
          priceScale: 1_000_000n,
          markObservedAtMs: BigInt(now.getTime()),
          markSourceHash: "old-prediction",
          markCondition: "fresh",
        },
        ...[
          [spotA, "spot-a"],
          [spotRemoved, "spot-removed"],
        ].map(([mint, marketId]) => ({
          assetKind: "spot" as const,
          marketId: marketId as string,
          tokenId: (mint as PublicKey).toBase58(),
          outcome: "spot",
          quantityUnits: 10_000_000n,
          markPriceUnits: 1_000_000n,
          priceScale: 1_000_000n,
          tokenDecimals: 6,
          markObservedAtMs: BigInt(now.getTime()),
          markSourceHash: "old-jupiter",
          markCondition: "fresh" as const,
        })),
      ],
    };
    const items = [
      {
        marketId: "m1",
        kind: {
          predictionMarket: {
            outcome: 1,
            ctfTokenId: bytes32(1),
          },
        },
        weightBps: 2_000,
      },
      {
        marketId: "m2",
        kind: {
          predictionMarket: {
            outcome: 0,
            ctfTokenId: bytes32(2),
          },
        },
        weightBps: 2_000,
      },
      {
        marketId: "spot-a",
        kind: { spot: { tokenMint: spotA } },
        weightBps: 2_000,
      },
      {
        marketId: "spot-b",
        kind: { spot: { tokenMint: spotB } },
        weightBps: 2_000,
      },
      {
        marketId: "spot-c",
        kind: { spot: { tokenMint: spotC } },
        weightBps: 2_000,
      },
    ] as const;
    const contract = await import("../src/contract/composition.js");
    const signedCompositionHash = contract.compositionHash(items);
    const eligibleMarkets = items.flatMap((item) =>
      "predictionMarket" in item.kind
        ? [{
            marketId: item.marketId,
            outcome: item.kind.predictionMarket.outcome,
            ctfTokenId: item.kind.predictionMarket.ctfTokenId,
          }]
        : [],
    );
    const store = new MemoryExecutionStore();
    const orders = new Map<string, string>();
    const swaps = new Map<string, {
      readonly idempotencyKey: string;
      readonly inputMint: PublicKey;
      readonly outputMint: PublicKey;
      readonly requestedInputUnits: bigint;
      readonly filledInputUnits: bigint;
      readonly filledOutputUnits: bigint;
      readonly minimumOutputUnits: bigint;
      readonly transactionSignature: string;
      readonly finalizedSlot: bigint;
      readonly executedAtMs: bigint;
      readonly status: "filled";
    }>();
    let marketCalls = 0;
    let priceCalls = 0;
    const usdcMint = new PublicKey(new Uint8Array(32).fill(65));
    const taker = new PublicKey(new Uint8Array(32).fill(66));
    const executor = new PolymarketReconstitutionExecutor(
      { loadBasketState: async () => state },
      store,
      {
        getMidpoint: async () => 500_000n,
        getOrderBook: async (tokenId) => {
          marketCalls += 1;
          return {
            marketId: tokenId === "1"
              ? condition
              : `0x${tokenId.repeat(64)}`,
            tokenId,
            timestampMs: BigInt(now.getTime()),
            bids: [{
              priceUnits: 490_000n,
              sizeUnits: 1_000_000_000n,
            }],
            asks: [{
              priceUnits: 510_000n,
              sizeUnits: 1_000_000_000n,
            }],
            minOrderSizeUnits: 1n,
            tickSizeUnits: 10_000n,
            negativeRisk: false,
            sourceHash: `book-${tokenId}`,
          };
        },
      },
      {
        executeFak: async (request) => {
          const orderId =
            orders.get(request.clientOrderId) ??
            `hybrid-order-${orders.size}`;
          orders.set(request.clientOrderId, orderId);
          return {
            clientOrderId: request.clientOrderId,
            orderId,
            tokenId: request.tokenId,
            side: request.side,
            requestedAmountUnits: request.amountUnits,
            filledInputUnits: request.amountUnits,
            filledOutputUnits: request.amountUnits * 2n,
            averagePriceUnits: request.worstPriceUnits,
            status: "matched",
            transactionHashes: [],
            tradeIds: [],
            executedAtMs: BigInt(now.getTime()),
          };
        },
      },
      { now: () => now },
      coordinator,
      "wallet-hybrid-reconstitution",
      executionGuard,
      100,
      undefined,
      {
        usdcMint,
        taker,
        tokens: {
          lookup: async () => {
            throw new Error("unexpected token batch lookup");
          },
          requireVerified: async (mint) => ({
            mint,
            name: "Test Spot",
            symbol: "TST",
            decimals: 6,
            tokenProgram: SystemProgram.programId,
            isVerified: true,
            tags: [],
            updatedAt: null,
          }),
        },
        prices: {
          getUsdcPrices: async (mints) => {
            priceCalls += 1;
            return mints.map((mint) => ({
              mint,
              priceUsdcUnits: 1_000_000n,
              observedAtMs: BigInt(now.getTime()),
              sourceHash: `jupiter-price-${mint.toBase58()}`,
            }));
          },
        },
        jupiter: {
          executeExactIn: async (request) => {
            const prior = swaps.get(request.idempotencyKey);
            if (prior !== undefined) return prior;
            const result = Object.freeze({
              idempotencyKey: request.idempotencyKey,
              inputMint: request.inputMint,
              outputMint: request.outputMint,
              requestedInputUnits: request.inputAmountUnits,
              filledInputUnits: request.inputAmountUnits,
              filledOutputUnits: request.inputAmountUnits,
              minimumOutputUnits:
                request.inputAmountUnits * 99n / 100n,
              transactionSignature:
                `hybrid-reconstitution-swap-${swaps.size}`,
              finalizedSlot: 70n,
              executedAtMs: BigInt(now.getTime()),
              status: "filled" as const,
            });
            swaps.set(request.idempotencyKey, result);
            return result;
          },
        },
      },
    );
    const authorization = {
      basket,
      basketId: new Uint8Array(32).fill(1),
      nextCompositionVersion: 2,
      compositionHash: signedCompositionHash,
      eligibilityHash: contract.eligibilityHash(eligibleMarkets),
      eligibilityNonce: 2n,
      eligibleMarkets,
      items,
      compositionNonce: 3n,
      compositionExpirySeconds: 2_000_000_100n,
      encodedMessage: new Uint8Array([1]),
      composerPublicKey: new Uint8Array(32).fill(2),
      composerSignature: new Uint8Array(64).fill(3),
    } as const;
    const first = await executor.rebalance({
      operationId: "hybrid-reconstitution-1",
      basket,
      previousCompositionVersion: 1,
      nextComposition: authorization,
    });
    const replay = await executor.rebalance({
      operationId: "hybrid-reconstitution-1",
      basket,
      previousCompositionVersion: 1,
      nextComposition: authorization,
    });
    assert.equal(first.executionHash, replay.executionHash);
    assert.equal(first.orderIds.length, 2);
    assert.equal(first.jupiterTransactions?.length, 4);
    assert.equal(orders.size, 2);
    assert.equal(swaps.size, 4);
    assert.equal(marketCalls, 2);
    assert.equal(priceCalls, 1);
    assert.equal(store.idle, 10_000_000n);
    assert.equal(store.idleUsdc, 0n);
    assert.equal(store.holdings.length, 5);
    assert.equal(
      store.holdings.some(
        (holding) => holding.tokenId === spotRemoved.toBase58(),
      ),
      false,
    );
  });

  it("redeems a shared-wallet condition once and attributes only basket-owned winning tokens", async () => {
    const wallet = `0x${"77".repeat(20)}`;
    const state: BasketAttributedState = {
      basketId: basket.toBase58(), ledgerVersion: "ledger-resolution", compositionVersion: 2n,
      compositionHash: oldHash, idlePusdUnits: 5_000_000n,
      holdings: [
        { marketId: "m", tokenId: "1", conditionId: condition, negativeRisk: false, outcome: "Yes", quantityUnits: 10_000_000n, markPriceUnits: 1_000_000n, priceScale: 1_000_000n, markObservedAtMs: 1n, markSourceHash: "resolved", markCondition: "fresh" },
        { marketId: "m", tokenId: "2", conditionId: condition, negativeRisk: false, outcome: "No", quantityUnits: 20_000_000n, markPriceUnits: 0n, priceScale: 1_000_000n, markObservedAtMs: 1n, markSourceHash: "resolved", markCondition: "fresh" },
      ],
    };
    const executionStore = new MemoryExecutionStore();
    let stored: ConditionRedemptionRecord | null = null;
    const redemptionStore: ConditionRedemptionStorePort = {
      load: async () => stored,
      prepare: async (request) => {
        stored ??= Object.freeze({ ...request, state: "prepared" });
        return stored;
      },
      complete: async (request) => {
        if (stored === null) throw new Error("redemption was not prepared");
        const result: ConditionRedemptionResult = Object.freeze({
          walletAddress: request.walletAddress,
          conditionId: request.conditionId,
          negativeRisk: request.negativeRisk,
          winningTokenId: request.winningTokenId,
          walletPayoutUnits: request.walletPayoutUnits,
          relayerTransactionId: request.relayerTransactionId,
          polygonTransactionHash: request.polygonTransactionHash,
        });
        stored = Object.freeze({ ...stored, ...result, state: "completed" });
        return result;
      },
    };
    const relayerOperations = new Set<string>();
    let relayed = false;
    let positionCalls = 0;
    const executor = new PolymarketResolutionExecutor(
      wallet,
      { loadBasketState: async () => state },
      executionStore,
      { listRedeemable: async () => {
        positionCalls += 1;
        if (positionCalls > 1) throw new Error("position source must not be required after durable preparation");
        return [
          { proxyWallet: wallet, tokenId: "1", conditionId: condition, sizeUnits: 100_000_000n, currentPriceUnits: 1_000_000n, redeemable: true, outcome: "Yes", outcomeIndex: 0, negativeRisk: false },
          { proxyWallet: wallet, tokenId: "2", conditionId: condition, sizeUnits: 80_000_000n, currentPriceUnits: 0n, redeemable: true, outcome: "No", outcomeIndex: 1, negativeRisk: false },
        ];
      } },
      redemptionStore,
      { execute: async (request) => { relayerOperations.add(request.operationId); relayed = true; return { transactionId: "relay", transactionHash: `0x${"88".repeat(32)}`, state: "STATE_CONFIRMED" }; } },
      { getPusdBalanceUnits: async () => relayed ? 1_100_000_000n : 1_000_000_000n },
      { now: () => now },
      coordinator,
      new FailOnceFaultInjector(["resolution.condition_redeemed"]),
    );
    const resolutionRequest = { operationId: "resolution-1", basket } as const;
    await assert.rejects(executor.resolve(resolutionRequest), /fault injected/u);
    const first = await executor.resolve(resolutionRequest);
    const replay = await executor.resolve(resolutionRequest);
    assert.equal(first.finalNavValue, 15_000_000n);
    assert.equal(replay.executionHash, first.executionHash);
    assert.equal(relayerOperations.size, 1);
    assert.equal(positionCalls, 1);
    assert.equal(executionStore.holdings.length, 0);
    assert.equal(executionStore.idle, 15_000_000n);
  });
});

describe("Solana lifecycle signing policy", () => {
  it("allows only approved lifecycle instructions and required signers", () => {
    const signer = new PublicKey(new Uint8Array(32).fill(90));
    const programId = new PublicKey(new Uint8Array(32).fill(91));
    const discriminator = createHash("sha256").update("global:begin_resolution", "utf8").digest().subarray(0, 8);
    const approved = new Transaction({ feePayer: signer, recentBlockhash: new PublicKey(new Uint8Array(32).fill(92)).toBase58() }).add(
      new TransactionInstruction({ programId, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: discriminator }),
    );
    assert.doesNotThrow(() => validateSolanaLifecycleMessage(approved.serializeMessage(), signer, programId));
    const rejected = new Transaction({ feePayer: signer, recentBlockhash: new PublicKey(new Uint8Array(32).fill(93)).toBase58() }).add(
      SystemProgram.transfer({ fromPubkey: signer, toPubkey: basket, lamports: 1 }),
    );
    assert.throws(() => validateSolanaLifecycleMessage(rejected.serializeMessage(), signer, programId), /unapproved program/u);
  });
});
