import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";

import { PublicKey } from "@solana/web3.js";

import {
  costBasisForShares,
  calculateWithdrawalSettlement,
  weightedAverageTimestamp,
} from "../src/accounting/math.js";
import { DepositWorkflow } from "../src/deposits/index.js";
import {
  allocateDepositPusd,
  allocateProportionalLiquidation,
  executionBatchHash,
  InMemoryExecutionOperationStore,
  type FakOrderRequest,
  type FakOrderResult,
} from "../src/execution/index.js";
import { IntentSubmissionService, QuoteService } from "../src/quotes/index.js";
import type { SolanaSettlementGatewayPort } from "../src/settlement/index.js";
import { ProtocolFeeWithdrawalWorkflow, WithdrawalWorkflow } from "../src/withdrawals/index.js";
import { depositIntentMessage, withdrawalIntentMessage } from "../src/contract/index.js";

function userSigner() {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  const publicKey = new PublicKey(der.subarray(der.length - 32));
  return {
    publicKey,
    sign: (message: Uint8Array) => sign(null, message, pair.privateKey),
  };
}

const basket = new PublicKey(new Uint8Array(32).fill(4));
const navHash = new Uint8Array(32).fill(8);
const nowSeconds = 2_000_000_000n;
const now = new Date(Number(nowSeconds * 1_000n));

describe("execution allocation and attestations", () => {
  it("leaves allocation dust idle and liquidation dust invested", () => {
    const targets = [
      { tokenId: "a", weightBps: 4_000, currentUnits: 11n },
      { tokenId: "b", weightBps: 3_000, currentUnits: 13n },
      { tokenId: "c", weightBps: 3_000, currentUnits: 17n },
    ] as const;
    const deposit = allocateDepositPusd(101n, targets);
    assert.deepEqual(deposit.targets.map((item) => item.amountUnits), [40n, 30n, 30n]);
    assert.equal(deposit.idlePusdUnits, 1n);
    const liquidation = allocateProportionalLiquidation(1n, 3n, targets);
    assert.deepEqual(liquidation.map((item) => item.amountUnits), [3n, 4n, 5n]);
  });

  it("hashes every fill field without delimiter ambiguity", () => {
    const base = {
      kind: "deposit" as const,
      operationId: "op-1",
      basket: basket.toBase58(),
      navReportHash: Buffer.from(navHash).toString("hex"),
      settlementNonce: 1n,
      executedAtSeconds: nowSeconds,
      idlePusdUnits: 1n,
      orders: [{
        clientOrderId: "a:b",
        orderId: "order",
        tokenId: "token",
        side: "buy" as const,
        requestedAmountUnits: 10n,
        filledInputUnits: 9n,
        filledOutputUnits: 18n,
        averagePriceUnits: 500_000n,
        status: "partially_filled" as const,
        transactionHashes: [],
        tradeIds: [],
        executedAtMs: nowSeconds * 1_000n,
      }],
    };
    const first = executionBatchHash(base);
    const second = executionBatchHash({ ...base, orders: [{ ...base.orders[0]!, clientOrderId: "a", orderId: "b:order" }] });
    assert.notDeepEqual(first, second);
  });
});

describe("quote and intent APIs", () => {
  it("binds an Ed25519 user signature to the exact deposit quote", () => {
    const user = userSigner();
    const quote = new QuoteService().createDepositQuote({
      basket,
      user: user.publicKey,
      compositionVersion: 1,
      navReportHash: navHash,
      basketNavValue: 10_000_000n,
      sharePrice: 1_000_000n,
      grossAmount: 1_000_000n,
      maxSlippageBps: 100,
      nowSeconds,
      expiresAtSeconds: nowSeconds + 60n,
    });
    const unsigned = (signature: Uint8Array) => new IntentSubmissionService().submitDeposit({
      quote,
      nonce: 1n,
      signature,
      nowSeconds,
    });
    assert.throws(() => unsigned(new Uint8Array(64)), /invalid user intent signature/u);
    const message = depositIntentMessage({
      basket,
      user: user.publicKey,
      intentNonce: 1n,
      intentExpiry: quote.expiresAtSeconds,
      expectedCompositionVersion: 1,
      grossAmount: quote.grossAmount,
      minSharesOut: quote.minSharesOut,
      quoteHash: quote.quoteHash,
    });
    assert.equal(unsigned(user.sign(message)).intentHash.length, 32);
  });

  it("rejects quotes whose validity crosses the 60-day withdrawal tier", () => {
    const user = userSigner();
    const maturity = nowSeconds + 30n;
    assert.throws(() => new QuoteService().createWithdrawalQuote({
      basket,
      user: user.publicKey,
      compositionVersion: 1,
      navReportHash: navHash,
      basketNavValue: 100_000_000n,
      sharePrice: 1_000_000n,
      shareAmount: 10_000_000n,
      sharesOwned: 100_000_000n,
      costBasisValue: 50_000_000n,
      weightedDepositTimestamp: maturity - 5_184_000n,
      performanceFeeBps: 1_000,
      maxSlippageBps: 100,
      nowSeconds,
      expiresAtSeconds: nowSeconds + 60n,
    }), /fee-tier boundary/u);
  });
});

describe("deposit crash/replay safety", () => {
  it("replays deterministic FAK and settlement IDs without duplicate side effects", async () => {
    const user = userSigner();
    const quote = new QuoteService().createDepositQuote({
      basket,
      user: user.publicKey,
      compositionVersion: 1,
      navReportHash: navHash,
      basketNavValue: 0n,
      sharePrice: 1_000_000n,
      grossAmount: 1_000_000n,
      maxSlippageBps: 100,
      nowSeconds,
      expiresAtSeconds: nowSeconds + 60n,
    });
    const message = depositIntentMessage({
      basket,
      user: user.publicKey,
      intentNonce: 1n,
      intentExpiry: quote.expiresAtSeconds,
      expectedCompositionVersion: 1,
      grossAmount: quote.grossAmount,
      minSharesOut: quote.minSharesOut,
      quoteHash: quote.quoteHash,
    });
    const intent = new IntentSubmissionService().submitDeposit({ quote, nonce: 1n, signature: user.sign(message), nowSeconds });
    const uniqueOrders = new Map<string, FakOrderResult>();
    const settlementBatches = new Set<string>();
    let settlementAttempts = 0;
    const settlement = {
      completeDeposit: async (request) => {
        const hash = Buffer.from(request.executionBatchHash).toString("hex");
        settlementBatches.add(hash);
        settlementAttempts += 1;
        if (settlementAttempts === 1) throw new Error("simulated crash after external execution");
        return { transactionSignature: "settled-deposit", receiptAddress: "receipt", finalizedSlot: 9n };
      },
      completeWithdrawal: async () => { throw new Error("unexpected withdrawal"); },
      completeProtocolFeeWithdrawal: async () => { throw new Error("unexpected protocol withdrawal"); },
    } satisfies SolanaSettlementGatewayPort;
    const workflow = new DepositWorkflow(
      new InMemoryExecutionOperationStore(),
      {
        createDepositAddress: async () => ({ svm: new PublicKey(new Uint8Array(32).fill(7)).toBase58(), evm: `0x${"11".repeat(20)}` }),
        createWithdrawalAddress: async () => { throw new Error("unexpected"); },
        getStatus: async (address) => [{ status: "COMPLETED", bridgeAddress: address, sourceTxHash: null, destinationTxHash: "polygon-tx", inputAmountUnits: quote.quotedNetValue, outputAmountUnits: quote.quotedNetValue, observedAtMs: nowSeconds * 1_000n }],
      },
      { verifyPusdCredit: async () => ({ amountUnits: quote.quotedNetValue, finalizedBlock: 99n }) },
      { verifyFinalizedTransfer: async (request) => ({ signature: request.signature, user: request.expectedUser, bridgeAddress: request.expectedBridgeAddress, mint: request.expectedMint, amountUnits: request.expectedAmountUnits, finalizedSlot: 2n }) },
      { executeFak: async (request: FakOrderRequest) => {
        const existing = uniqueOrders.get(request.clientOrderId);
        if (existing !== undefined) return existing;
        const result: FakOrderResult = {
          clientOrderId: request.clientOrderId,
          orderId: `order-${request.clientOrderId}`,
          tokenId: request.tokenId,
          side: request.side,
          requestedAmountUnits: request.amountUnits,
          filledInputUnits: request.amountUnits - 1n,
          filledOutputUnits: (request.amountUnits - 1n) * 2n,
          averagePriceUnits: 500_000n,
          status: "partially_filled",
          transactionHashes: [],
          tradeIds: [],
          executedAtMs: nowSeconds * 1_000n,
        };
        uniqueOrders.set(request.clientOrderId, result);
        return result;
      } },
      { loadLatestPricing: async () => ({ navReportHash: navHash, basketNavValue: quote.basketNavValue, sharePrice: quote.sharePrice, observedAtSeconds: nowSeconds }) },
      settlement,
    );
    const prepared = await workflow.prepare({ operationId: "10000000-0000-4000-8000-000000000001", requestKey: "deposit-1", workflowId: "deposit-1", intent, polymarketWallet: `0x${"22".repeat(20)}`, now });
    const request = {
      operationId: "10000000-0000-4000-8000-000000000001",
      requestKey: "deposit-1",
      workflowId: "deposit-1",
      intent,
      polymarketWallet: `0x${"22".repeat(20)}`,
      preparedBridgeAddress: prepared.bridgeAddress,
      solanaUsdcMint: new PublicKey(new Uint8Array(32).fill(9)).toBase58(),
      protocolFeeDestination: new PublicKey(new Uint8Array(32).fill(10)).toBase58(),
      fundingTransactionSignature: "solana-funding",
      maxSlippageBps: 100,
      targets: [
        { tokenId: "a", weightBps: 4_000, worstBuyPriceUnits: 600_000n },
        { tokenId: "b", weightBps: 3_000, worstBuyPriceUnits: 600_000n },
        { tokenId: "c", weightBps: 3_000, worstBuyPriceUnits: 600_000n },
      ],
      settlementNonce: 1n,
      now,
    } as const;
    await assert.rejects(workflow.execute(request), /simulated crash/u);
    const first = await workflow.execute(request);
    const replay = await workflow.execute(request);
    assert.equal(first.operation.state, "completed");
    assert.equal(replay.executionBatchHash, first.executionBatchHash);
    assert.equal(uniqueOrders.size, 3);
    assert.equal(settlementBatches.size, 1);
    assert.equal(settlementAttempts, 3);
    assert.equal(first.idlePusdUnits, 3n);
  });
});

describe("withdrawal vertical slice", () => {
  it("accepts partial FAK fills, bridges once, splits atomically and replays safely", async () => {
    const user = userSigner();
    const destination = new PublicKey(new Uint8Array(32).fill(12));
    const quote = new QuoteService().createWithdrawalQuote({
      basket,
      user: user.publicKey,
      compositionVersion: 1,
      navReportHash: navHash,
      basketNavValue: 100_000_000n,
      sharePrice: 1_000_000n,
      shareAmount: 10_000_000n,
      sharesOwned: 100_000_000n,
      costBasisValue: 50_000_000n,
      weightedDepositTimestamp: nowSeconds - 2_592_000n,
      performanceFeeBps: 1_000,
      maxSlippageBps: 0,
      nowSeconds,
      expiresAtSeconds: nowSeconds + 60n,
    });
    const message = withdrawalIntentMessage({
      basket,
      user: user.publicKey,
      intentNonce: 1n,
      intentExpiry: quote.expiresAtSeconds,
      expectedCompositionVersion: 1,
      shareAmount: quote.shareAmount,
      minValueOut: quote.minValueOut,
      destination,
      quoteHash: quote.quoteHash,
    });
    const intent = new IntentSubmissionService().submitWithdrawal({
      quote,
      nonce: 1n,
      destination,
      signature: user.sign(message),
      nowSeconds,
    });
    const orders = new Map<string, FakOrderResult>();
    const transfers = new Set<string>();
    const splits = new Set<string>();
    const settlements = new Set<string>();
    const bridgeEvm = `0x${"33".repeat(20)}`;
    const workflow = new WithdrawalWorkflow(
      new InMemoryExecutionOperationStore(),
      { executeFak: async (request) => {
        const existing = orders.get(request.clientOrderId);
        if (existing !== undefined) return existing;
        const result: FakOrderResult = {
          clientOrderId: request.clientOrderId,
          orderId: `order-${request.clientOrderId}`,
          tokenId: request.tokenId,
          side: "sell",
          requestedAmountUnits: request.amountUnits,
          filledInputUnits: request.amountUnits,
          filledOutputUnits: (request.amountUnits * 9n) / 10n,
          averagePriceUnits: 900_000n,
          status: "matched",
          transactionHashes: [],
          tradeIds: [],
          executedAtMs: nowSeconds * 1_000n,
        };
        orders.set(request.clientOrderId, result);
        return result;
      } },
      {
        createDepositAddress: async () => { throw new Error("unexpected"); },
        createWithdrawalAddress: async () => ({ evm: bridgeEvm, svm: new PublicKey(new Uint8Array(32).fill(13)).toBase58() }),
        getStatus: async (address) => [{ status: "COMPLETED", bridgeAddress: address, sourceTxHash: "polygon-send", destinationTxHash: "solana-bridge", inputAmountUnits: 10_000_000n, outputAmountUnits: 10_000_000n, observedAtMs: nowSeconds * 1_000n }],
      },
      { transferPusd: async (request) => {
        transfers.add(request.idempotencyKey);
        return { transactionHash: "polygon-send" };
      } },
      { verifyReceived: async () => ({ amountUnits: 10_000_000n, transactionSignature: "solana-bridge", finalizedSlot: 10n }) },
      { distribute: async (request) => {
        assert.equal(request.userAmountUnits + request.creatorAmountUnits + request.protocolAmountUnits, 10_000_000n);
        splits.add(request.idempotencyKey);
        return { transactionSignature: "split", finalizedSlot: 11n };
      } },
      { loadLatestPricing: async () => ({ navReportHash: navHash, basketNavValue: quote.basketNavValue, sharePrice: quote.sharePrice, observedAtSeconds: nowSeconds }) },
      {
        completeDeposit: async () => { throw new Error("unexpected deposit"); },
        completeWithdrawal: async (request) => {
          settlements.add(Buffer.from(request.executionBatchHash).toString("hex"));
          return { transactionSignature: "withdraw-settlement", receiptAddress: "receipt", finalizedSlot: 12n };
        },
        completeProtocolFeeWithdrawal: async () => { throw new Error("unexpected protocol redemption"); },
      },
    );
    const request = {
      operationId: "20000000-0000-4000-8000-000000000002",
      requestKey: "withdrawal-1",
      workflowId: "withdrawal-1",
      intent,
      polymarketWallet: `0x${"44".repeat(20)}`,
      totalSharesOutstanding: 100_000_000n,
      positionSharesOwned: 100_000_000n,
      positionCostBasisValue: 50_000_000n,
      weightedDepositTimestamp: nowSeconds - 2_592_000n,
      idlePusdUnits: 10_000_000n,
      targets: [
        { tokenId: "a", weightBps: 4_000, currentUnits: 40_000_000n, worstSellPriceUnits: 800_000n },
        { tokenId: "b", weightBps: 3_000, currentUnits: 30_000_000n, worstSellPriceUnits: 800_000n },
        { tokenId: "c", weightBps: 3_000, currentUnits: 30_000_000n, worstSellPriceUnits: 800_000n },
      ],
      performanceFeeBps: 1_000,
      maxSlippageBps: 0,
      creatorDestination: new PublicKey(new Uint8Array(32).fill(14)).toBase58(),
      protocolDestination: new PublicKey(new Uint8Array(32).fill(15)).toBase58(),
      solanaSettlementReceiver: new PublicKey(new Uint8Array(32).fill(16)).toBase58(),
      solanaUsdcMint: new PublicKey(new Uint8Array(32).fill(17)).toBase58(),
      solanaChainId: "1151111081099710",
      settlementNonce: 2n,
      now,
    } as const;
    const first = await workflow.execute(request);
    const replay = await workflow.execute(request);
    assert.equal(first.operation.state, "completed");
    assert.equal(first.grossRealizedValue, 10_000_000n);
    assert.equal(first.creatorFee, 500_000n);
    assert.equal(first.protocolFee, 200_000n);
    assert.equal(first.userValueOut, 9_300_000n);
    assert.equal(replay.executionBatchHash, first.executionBatchHash);
    assert.equal(orders.size, 3);
    assert.equal(transfers.size, 1);
    assert.equal(splits.size, 1);
    assert.equal(settlements.size, 1);
  });

  it("rejects duplicate request keys with different financial content", async () => {
    const store = new InMemoryExecutionOperationStore();
    const base = {
      id: "30000000-0000-4000-8000-000000000003",
      requestKey: "duplicate",
      requestHash: "11".repeat(32),
      kind: "deposit" as const,
      workflowId: "workflow-duplicate",
      basket: basket.toBase58(),
      checkpoint: {},
      createdAt: now,
    };
    await store.createOrLoad(base);
    await assert.rejects(store.createOrLoad({ ...base, id: "40000000-0000-4000-8000-000000000004", requestHash: "22".repeat(32) }), /different content/u);
  });
});

describe("withdrawal fees and redeemed-share high-water behavior", () => {
  it("charges only redeemed-share profit and preserves the remaining basis", () => {
    const first = calculateWithdrawalSettlement(
      100_000_000n,
      100_000_000n,
      nowSeconds - 2_592_000n,
      50_000_000n,
      80_000_000n,
      nowSeconds,
      1_000,
    );
    assert.equal(first.costBasis, 50_000_000n);
    assert.equal(first.realizedProfit, 30_000_000n);
    assert.equal(first.creatorFee, 3_000_000n);
    const remainingBasis = 100_000_000n - first.costBasis;
    const second = calculateWithdrawalSettlement(
      remainingBasis,
      50_000_000n,
      nowSeconds - 2_592_000n,
      50_000_000n,
      90_000_000n,
      nowSeconds,
      1_000,
    );
    assert.equal(second.costBasis, 50_000_000n);
    assert.equal(second.creatorFee, 4_000_000n);
  });

  it("covers profit/loss, early/mature, partial/full and weighted multiple-entry cases", () => {
    const weighted = weightedAverageTimestamp(100n, nowSeconds - 10_000n, 300n, nowSeconds);
    assert.equal(weighted, nowSeconds - 2_500n);
    assert.equal(costBasisForShares(101n, 1n, 3n), 34n);
    assert.equal(costBasisForShares(67n, 2n, 2n), 67n);
    const loss = calculateWithdrawalSettlement(100n, 10n, nowSeconds - 6_000_000n, 5n, 40n, nowSeconds, 2_000);
    assert.equal(loss.creatorFee, 0n);
    assert.equal(loss.protocolFee, 1n);
    const early = calculateWithdrawalSettlement(100n, 10n, nowSeconds - 1n, 10n, 200n, nowSeconds, 1_000);
    assert.equal(early.creatorFee, 10n);
    assert.equal(early.protocolFee, 4n);
  });
});

describe("protocol management-share redemption", () => {
  it("liquidates, bridges, transfers only to protocol and settles idempotently", async () => {
    const orders = new Map<string, FakOrderResult>();
    const transfers = new Set<string>();
    const distributions = new Set<string>();
    const settlements = new Set<string>();
    const bridgeEvm = `0x${"55".repeat(20)}`;
    const workflow = new ProtocolFeeWithdrawalWorkflow(
      new InMemoryExecutionOperationStore(),
      { executeFak: async (request) => {
        const previous = orders.get(request.clientOrderId);
        if (previous !== undefined) return previous;
        const result: FakOrderResult = {
          clientOrderId: request.clientOrderId,
          orderId: `order-${request.clientOrderId}`,
          tokenId: request.tokenId,
          side: "sell",
          requestedAmountUnits: request.amountUnits,
          filledInputUnits: request.amountUnits,
          filledOutputUnits: request.amountUnits,
          averagePriceUnits: 1_000_000n,
          status: "matched",
          transactionHashes: [],
          tradeIds: [],
          executedAtMs: nowSeconds * 1_000n,
        };
        orders.set(request.clientOrderId, result);
        return result;
      } },
      {
        createDepositAddress: async () => { throw new Error("unexpected"); },
        createWithdrawalAddress: async () => ({ evm: bridgeEvm, svm: new PublicKey(new Uint8Array(32).fill(18)).toBase58() }),
        getStatus: async (address) => [{ status: "COMPLETED", bridgeAddress: address, sourceTxHash: "polygon-protocol-send", destinationTxHash: "solana-protocol-bridge", inputAmountUnits: 10_000_000n, outputAmountUnits: 10_000_000n, observedAtMs: nowSeconds * 1_000n }],
      },
      { transferPusd: async (request) => {
        transfers.add(request.idempotencyKey);
        return { transactionHash: "polygon-protocol-send" };
      } },
      { verifyReceived: async () => ({ amountUnits: 10_000_000n, transactionSignature: "solana-protocol-bridge", finalizedSlot: 20n }) },
      { distribute: async (request) => {
        assert.equal(request.userAmountUnits, 0n);
        assert.equal(request.creatorAmountUnits, 0n);
        assert.equal(request.protocolAmountUnits, 10_000_000n);
        distributions.add(request.idempotencyKey);
        return { transactionSignature: "protocol-transfer", finalizedSlot: 21n };
      } },
      { loadLatestPricing: async () => ({ navReportHash: navHash, basketNavValue: 100_000_000n, sharePrice: 1_000_000n, observedAtSeconds: nowSeconds }) },
      {
        completeDeposit: async () => { throw new Error("unexpected deposit"); },
        completeWithdrawal: async () => { throw new Error("unexpected user withdrawal"); },
        completeProtocolFeeWithdrawal: async (request) => {
          settlements.add(Buffer.from(request.executionBatchHash).toString("hex"));
          return { transactionSignature: "protocol-settlement", receiptAddress: "receipt", finalizedSlot: 22n };
        },
      },
    );
    const request = {
      operationId: "50000000-0000-4000-8000-000000000005",
      requestKey: "protocol-redemption-1",
      workflowId: "protocol-redemption-1",
      basket,
      navReportHash: navHash,
      basketNavValue: 100_000_000n,
      sharePrice: 1_000_000n,
      shareAmount: 10_000_000n,
      protocolFeeShares: 20_000_000n,
      totalSharesOutstanding: 100_000_000n,
      idlePusdUnits: 0n,
      targets: [
        { tokenId: "a", weightBps: 4_000, currentUnits: 40_000_000n, worstSellPriceUnits: 1_000_000n - 1n },
        { tokenId: "b", weightBps: 3_000, currentUnits: 30_000_000n, worstSellPriceUnits: 1_000_000n - 1n },
        { tokenId: "c", weightBps: 3_000, currentUnits: 30_000_000n, worstSellPriceUnits: 1_000_000n - 1n },
      ],
      maxSlippageBps: 0,
      polymarketWallet: `0x${"66".repeat(20)}`,
      protocolDestination: new PublicKey(new Uint8Array(32).fill(19)).toBase58(),
      solanaSettlementReceiver: new PublicKey(new Uint8Array(32).fill(20)).toBase58(),
      solanaUsdcMint: new PublicKey(new Uint8Array(32).fill(21)).toBase58(),
      solanaChainId: "1151111081099710",
      settlementNonce: 3n,
      now,
    } as const;
    const first = await workflow.execute(request);
    const replay = await workflow.execute(request);
    assert.equal(first.grossRealizedValue, 10_000_000n);
    assert.equal(first.operation.state, "completed");
    assert.equal(replay.executionBatchHash, first.executionBatchHash);
    assert.equal(orders.size, 3);
    assert.equal(transfers.size, 1);
    assert.equal(distributions.size, 1);
    assert.equal(settlements.size, 1);
  });
});
