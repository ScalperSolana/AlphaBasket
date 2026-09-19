import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";

import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { z } from "zod";

import { loadBackendConfig } from "../src/config/env.js";
import { depositIntentMessage, withdrawalIntentMessage } from "../src/contract/index.js";
import { DepositWorkflow } from "../src/deposits/index.js";
import {
  InMemoryExecutionOperationStore,
  type FakOrderResult,
  type SolanaAtomicSplitPort,
} from "../src/execution/index.js";
import {
  JupiterPredictOrderGateway,
  SolanaUsdcSplitGateway,
  createExecutionGatewayHttpServer,
  hashGatewayPredictOrder,
  solanaPredictOrderMessageValidator,
  type ExecutionGatewayServicePort,
  type GatewayRequestKind,
  type GatewayRequestStorePort,
  type PreparedGatewayRequest,
} from "../src/gateway/index.js";
import type { PolicyEnforcedSigner as PolicyEnforcedSignerType } from "../src/signer/index.js";
import { HttpSolanaAtomicSplit, type JsonHttpClient } from "../src/polymarket/index.js";
import type { SqlClient, SqlExecutor } from "../src/persistence/index.js";
import { ApiRequestError, PostgresQuoteContextStore } from "../src/server/index.js";
import {
  HttpJupiterPredictExecution,
  JupiterPredictMarketData,
  JupiterPredictMarketResolver,
  JupiterPredictRest,
  type PredictMarket,
  type PredictMarketLink,
  type PredictMarketLinkStorePort,
  type PredictOrderBuild,
  type PredictOrderStatus,
  type PredictRestPort,
} from "../src/predict/index.js";
import { IntentSubmissionService, QuoteService } from "../src/quotes/index.js";
import { InMemorySignerAuditSink, PolicyEnforcedSigner } from "../src/signer/index.js";
import { ProtocolFeeWithdrawalWorkflow, WithdrawalWorkflow } from "../src/withdrawals/index.js";

const NOW = new Date("2026-09-01T10:00:00.000Z");
const nowSeconds = BigInt(Math.floor(NOW.getTime() / 1_000));
const basket = new PublicKey(new Uint8Array(32).fill(4));
const navHash = new Uint8Array(32).fill(8);
const usdcMint = new PublicKey(new Uint8Array(32).fill(9));
const predictProgram = new PublicKey(new Uint8Array(32).fill(21));

const baseEnvironment = Object.freeze({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://localhost/alphabasket",
  ACCOUNTING_SOLANA_RPC_URL: "http://localhost:8899",
  CAPITAL_SOLANA_RPC_URL: "http://localhost:8899",
  CAPITAL_SOLANA_USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  COMPOSER_SIGNER_KEY_ID: "composer-test",
  BACKEND_SIGNER_KEY_ID: "backend-test",
  POLYMARKET_SIGNER_KEY_ID: "polymarket-test",
  SOLANA_SETTLEMENT_SIGNER_KEY_ID: "settlement-test",
});

function userSigner() {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  const publicKey = new PublicKey(der.subarray(der.length - 32));
  return {
    publicKey,
    publicBytes: Uint8Array.from(der.subarray(der.length - 32)),
    sign: (message: Uint8Array) => sign(null, message, pair.privateKey),
  };
}

const walletCoordinator = Object.freeze({
  execute: async <Result>(
    _walletId: string,
    _operationId: string,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> => operation(new AbortController().signal),
});
const executionGuard = Object.freeze({ authorize: async () => undefined });
const throwingBridge = Object.freeze({
  createDepositAddress: async () => { throw new Error("bridge must not be called on the Jupiter Predict venue"); },
  createWithdrawalAddress: async () => { throw new Error("bridge must not be called on the Jupiter Predict venue"); },
  getStatus: async () => { throw new Error("bridge must not be called on the Jupiter Predict venue"); },
});

describe("prediction venue configuration", () => {
  it("defaults to disabled and maps the deprecated Polymarket flag", () => {
    assert.equal(loadBackendConfig({ ...baseEnvironment }).prediction.venue, "disabled");
    assert.equal(
      loadBackendConfig({ ...baseEnvironment, POLYMARKET_ENABLED: "true" }).prediction.venue,
      "polymarket",
    );
    assert.throws(
      () => loadBackendConfig({
        ...baseEnvironment,
        POLYMARKET_ENABLED: "true",
        PREDICTION_VENUE: "jupiter_predict",
        SOLANA_SETTLEMENT_RECEIVER: "SysvarRent111111111111111111111111111111111",
      }),
      /conflicts with PREDICTION_VENUE/u,
    );
  });

  it("requires the settlement receiver for the Jupiter Predict venue", () => {
    assert.throws(
      () => loadBackendConfig({ ...baseEnvironment, PREDICTION_VENUE: "jupiter_predict" }),
      /SOLANA_SETTLEMENT_RECEIVER is required/u,
    );
    const config = loadBackendConfig({
      ...baseEnvironment,
      PREDICTION_VENUE: "jupiter_predict",
      SOLANA_SETTLEMENT_RECEIVER: "SysvarRent111111111111111111111111111111111",
      JUPITER_PREDICT_PROGRAM_IDS: predictProgram.toBase58(),
    });
    assert.equal(config.prediction.venue, "jupiter_predict");
    assert.equal(config.jupiterPredict.url, "https://api.jup.ag/prediction/v1");
    assert.deepEqual(config.jupiterPredict.programIds, [predictProgram.toBase58()]);
    assert.equal(config.jupiterPredict.minimumOrderUnits, 5_000_000n);
  });
});

function fakeHttp(routes: Readonly<Record<string, unknown>>): JsonHttpClient {
  const respond = async <Schema extends z.ZodTypeAny>(
    method: string,
    url: string,
    schema: Schema,
  ): Promise<z.output<Schema>> => {
    const fixture = routes[`${method} ${url}`];
    if (fixture === undefined) throw new Error(`unexpected ${method} ${url}`);
    return schema.parse(typeof fixture === "function" ? (fixture as () => unknown)() : fixture);
  };
  return {
    get: async (url: string, schema: z.ZodTypeAny) => respond("GET", url, schema),
    post: async (url: string, _body: unknown, schema: z.ZodTypeAny) => respond("POST", url, schema),
  } as unknown as JsonHttpClient;
}

class MemoryLinkStore implements PredictMarketLinkStorePort {
  public readonly links = new Map<string, PredictMarketLink>();

  public async load(tokenId: string): Promise<PredictMarketLink | null> {
    return this.links.get(tokenId) ?? null;
  }

  public async save(link: PredictMarketLink): Promise<void> {
    const existing = this.links.get(link.tokenId);
    if (existing?.source === "operator") return;
    this.links.set(link.tokenId, link);
  }
}

const CTF_TOKEN = "123456789012345678901234567890";
const CONDITION = `0x${"ab".repeat(32)}`;

describe("Jupiter Predict REST and market data", () => {
  const marketFixture = {
    marketId: "mkt-sol-500",
    eventId: "evt-1",
    provider: "polymarket",
    status: "open",
    outcomes: ["Yes", "No"],
    conditionId: CONDITION,
    clobTokenIds: [CTF_TOKEN],
    pricing: {
      buyYesPriceUsd: 650_000,
      buyNoPriceUsd: 380_000,
      sellYesPriceUsd: 620_000,
      sellNoPriceUsd: 350_000,
    },
  };

  it("parses markets, bounds prices, and surfaces external identifiers", async () => {
    const rest = new JupiterPredictRest(
      fakeHttp({
        "GET https://api.jup.ag/prediction/v1/markets/mkt-sol-500": marketFixture,
      }),
      { apiKey: "test", nowMs: () => 1_000n },
    );
    const market = await rest.getMarket("mkt-sol-500");
    assert.equal(market.provider, "polymarket");
    assert.equal(market.pricing.buyYesPriceUnits, 650_000n);
    assert.equal(market.pricing.sellNoPriceUnits, 350_000n);
    assert.ok(market.externalIds.includes(CONDITION.toLowerCase()));
    assert.ok(market.externalIds.includes(CTF_TOKEN));
  });

  it("resolves a market through the catalog, persists the link, and refuses a label mismatch", async () => {
    const links = new MemoryLinkStore();
    const rest = new JupiterPredictRest(
      fakeHttp({
        "GET https://api.jup.ag/prediction/v1/events?provider=polymarket&includeMarkets=true&start=0&end=100": {
          data: [{ markets: [marketFixture] }],
        },
      }),
      { apiKey: "test" },
    );
    const resolver = new JupiterPredictMarketResolver(rest, links, { maxCatalogPages: 1 });
    const resolved = await resolver.resolve({
      tokenId: CTF_TOKEN,
      conditionId: CONDITION,
      outcomeIndex: 1,
    });
    assert.deepEqual(resolved, { jupiterMarketId: "mkt-sol-500", isYes: false });
    assert.equal(links.links.get(CTF_TOKEN)?.source, "catalog");
    // A second resolution never rescans the catalog: the link answers.
    const cached = new JupiterPredictMarketResolver(
      { getMarket: async () => { throw new Error("unexpected"); },
        listCatalogMarkets: async () => { throw new Error("unexpected"); },
        buildOrder: async () => { throw new Error("unexpected"); },
        getOrderStatus: async () => { throw new Error("unexpected"); } },
      links,
    );
    assert.deepEqual(await cached.resolve({ tokenId: CTF_TOKEN }), resolved);

    // Outcome labels are authoritative over the index-0-is-yes convention.
    const flipped = new JupiterPredictRest(
      fakeHttp({
        "GET https://api.jup.ag/prediction/v1/events?provider=polymarket&includeMarkets=true&start=0&end=100": {
          data: [{ markets: [{ ...marketFixture, outcomes: ["No", "Yes"] }] }],
        },
      }),
      { apiKey: "test" },
    );
    assert.deepEqual(
      await new JupiterPredictMarketResolver(flipped, new MemoryLinkStore(), { maxCatalogPages: 1 })
        .resolve({ tokenId: CTF_TOKEN, conditionId: CONDITION, outcomeIndex: 0 }),
      { jupiterMarketId: "mkt-sol-500", isYes: false },
    );

    // A label that is neither yes nor no is refused rather than guessed.
    const unlabeled = new JupiterPredictRest(
      fakeHttp({
        "GET https://api.jup.ag/prediction/v1/events?provider=polymarket&includeMarkets=true&start=0&end=100": {
          data: [{ markets: [{ ...marketFixture, outcomes: ["Over 4.5", "Under 4.5"] }] }],
        },
      }),
      { apiKey: "test" },
    );
    await assert.rejects(
      new JupiterPredictMarketResolver(unlabeled, new MemoryLinkStore(), { maxCatalogPages: 1 })
        .resolve({ tokenId: CTF_TOKEN, conditionId: CONDITION, outcomeIndex: 0 }),
      /not a yes\/no label/u,
    );
  });

  it("refuses to resolve a market whose payload never carries the identity", async () => {
    const rest = new JupiterPredictRest(
      fakeHttp({
        "GET https://api.jup.ag/prediction/v1/events?provider=polymarket&includeMarkets=true&start=0&end=100": {
          data: [{ markets: [{ ...marketFixture, conditionId: undefined, clobTokenIds: [] }] }],
        },
        "GET https://api.jup.ag/prediction/v1/events?provider=polymarket&includeMarkets=true&start=100&end=200": {
          data: [],
        },
      }),
      { apiKey: "test" },
    );
    await assert.rejects(
      new JupiterPredictMarketResolver(rest, new MemoryLinkStore(), { maxCatalogPages: 2 })
        .resolve({ tokenId: "999999999999", conditionId: null, outcomeIndex: 0 }),
      /insert a predict_market_links row/u,
    );
  });

  it("serves the existing order-book port from linked Predict quotes", async () => {
    const links = new MemoryLinkStore();
    links.links.set(CTF_TOKEN, {
      tokenId: CTF_TOKEN,
      conditionId: CONDITION,
      jupiterMarketId: "mkt-sol-500",
      isYes: false,
      source: "operator",
    });
    const data = new JupiterPredictMarketData(
      new JupiterPredictRest(
        fakeHttp({
          "GET https://api.jup.ag/prediction/v1/markets/mkt-sol-500": marketFixture,
        }),
        { apiKey: "test", nowMs: () => 5_000n },
      ),
      links,
      { minimumOrderUnits: 5_000_000n },
    );
    const book = await data.getOrderBook(CTF_TOKEN);
    // The NO side: buy price is the ask, sell price the bid.
    assert.equal(book.marketId, CONDITION);
    assert.equal(book.asks[0]?.priceUnits, 380_000n);
    assert.equal(book.bids[0]?.priceUnits, 350_000n);
    assert.equal(book.negativeRisk, false);
    assert.equal(await data.getMidpoint(CTF_TOKEN), 365_000n);
    await assert.rejects(data.getOrderBook("42"), /insert a predict_market_links row/u);
  });
});

class MemoryGatewayStore implements GatewayRequestStorePort {
  public readonly entries = new Map<string, PreparedGatewayRequest>();

  public async prepare(request: {
    readonly requestKey: string;
    readonly requestKind: GatewayRequestKind;
    readonly requestHash: string;
    readonly build: () => Promise<{
      readonly signedPayload: Uint8Array;
      readonly transactionReference?: string;
    }>;
    readonly now: Date;
  }): Promise<PreparedGatewayRequest> {
    const existing = this.entries.get(request.requestKey);
    if (existing !== undefined) {
      if (existing.requestHash !== request.requestHash) {
        throw new Error("request key reused with different content");
      }
      return existing;
    }
    const built = await request.build();
    const created = Object.freeze({
      requestKey: request.requestKey,
      requestKind: request.requestKind,
      requestHash: request.requestHash,
      signedPayload: Uint8Array.from(built.signedPayload),
      transactionReference: built.transactionReference ?? null,
      state: "prepared" as const,
      result: null,
    });
    this.entries.set(request.requestKey, created);
    return created;
  }

  public async markSubmitted(requestKey: string, transactionReference: string): Promise<void> {
    const existing = this.entries.get(requestKey);
    if (existing === undefined) throw new Error("unknown request key");
    this.entries.set(requestKey, Object.freeze({ ...existing, state: "submitted" as const, transactionReference }));
  }

  public async markFinalized(
    requestKey: string,
    transactionReference: string,
    result: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const existing = this.entries.get(requestKey);
    if (existing === undefined) throw new Error("unknown request key");
    this.entries.set(requestKey, Object.freeze({
      ...existing,
      state: "finalized" as const,
      transactionReference,
      result,
    }));
  }

  public async claimCapitalSources(): Promise<void> {}

  public async findFinalizedByTransactionReference(
    requestKind: GatewayRequestKind,
    transactionReference: string,
  ): Promise<PreparedGatewayRequest | null> {
    for (const entry of this.entries.values()) {
      if (
        entry.requestKind === requestKind &&
        entry.transactionReference === transactionReference &&
        entry.state === "finalized"
      ) {
        return entry;
      }
    }
    return null;
  }
}

function predictGatewayHarness(options: {
  readonly market: PredictMarket;
  readonly contractsMicro: bigint | null;
  readonly usdcDeltaUnits: bigint;
  readonly orderStatuses?: readonly PredictOrderStatus[];
  readonly buildProgram?: PublicKey;
}) {
  const owner = userSigner();
  const taker = owner.publicKey;
  const statuses = [...(options.orderStatuses ?? ["filled" as const])];
  const calls = { buildOrder: 0, sentTransactions: [] as string[] };
  const message = new TransactionMessage({
    payerKey: taker,
    recentBlockhash: bs58.encode(new Uint8Array(32).fill(1)),
    instructions: [
      new TransactionInstruction({
        programId: options.buildProgram ?? predictProgram,
        keys: [],
        data: Buffer.from([7]),
      }),
    ],
  }).compileToV0Message();
  const unsigned = new VersionedTransaction(message);
  const rest: PredictRestPort = {
    getMarket: async () => options.market,
    listCatalogMarkets: async () => [],
    buildOrder: async (request): Promise<PredictOrderBuild> => {
      calls.buildOrder += 1;
      assert.equal(request.ownerPubkey, taker.toBase58());
      assert.equal(request.depositMint, usdcMint.toBase58());
      return {
        transactionBase64: Buffer.from(unsigned.serialize()).toString("base64"),
        orderPubkey: new PublicKey(new Uint8Array(32).fill(23)).toBase58(),
        positionPubkey: new PublicKey(new Uint8Array(32).fill(24)).toBase58(),
        contractsMicro: options.contractsMicro,
        lastValidBlockHeight: 100n,
      };
    },
    getOrderStatus: async () => statuses.length > 1 ? (statuses.shift() as PredictOrderStatus) : (statuses[0] as PredictOrderStatus),
  };
  const signer = new PolicyEnforcedSigner({
    policies: [{
      role: "solana_settlement",
      keyReference: "kms://settlement-test",
      algorithm: "ed25519",
      expectedPublicKey: owner.publicBytes,
      allowedDomains: new Set(["alphabasket:solana-capital-transaction:v1"]),
      allowedActions: new Set(["execute_predict_order"]),
      allowedNetworks: new Set(["solana-mainnet-beta"]),
      maxPayloadBytes: 1_232,
      requireExpiry: true,
      maxExpiryMs: 60_000,
      requiredContext: new Set(["intentHash"]),
      validatePayload: solanaPredictOrderMessageValidator({
        sourceOwner: taker,
        allowedProgramIds: [predictProgram],
      }),
    }],
    keySigner: {
      sign: async (request) => ({
        signature: owner.sign(request.payload),
        publicKey: owner.publicBytes,
      }),
    },
    auditSink: new InMemorySignerAuditSink(),
    now: () => NOW,
  });
  const connection = {
    getSignatureStatuses: async () => ({ value: [null] }),
    sendRawTransaction: async (raw: Buffer) => {
      const transaction = VersionedTransaction.deserialize(Uint8Array.from(raw));
      const signature = bs58.encode(transaction.signatures[0] as Uint8Array);
      calls.sentTransactions.push(signature);
      return signature;
    },
    confirmTransaction: async () => ({ value: { err: null }, context: { slot: 77 } }),
    getParsedTransaction: async () => ({
      slot: 77,
      meta: {
        err: null,
        preTokenBalances: [{
          owner: taker.toBase58(),
          mint: usdcMint.toBase58(),
          uiTokenAmount: { amount: "50000000" },
        }],
        postTokenBalances: [{
          owner: taker.toBase58(),
          mint: usdcMint.toBase58(),
          uiTokenAmount: { amount: (50_000_000n + options.usdcDeltaUnits).toString(10) },
        }],
      },
    }),
  } as unknown as Connection;
  const store = new MemoryGatewayStore();
  const gateway = new JupiterPredictOrderGateway(store, signer, rest, connection, {
    deploymentMode: "hybrid_devnet",
    taker,
    usdcMint,
    allowedProgramIds: [predictProgram],
    maximumOrderUnits: 10_000_000n,
    minimumOrderUnits: 5_000_000n,
    fillPollAttempts: 3,
    fillPollDelayMs: 1,
    now: () => NOW,
    sleep: async () => undefined,
  });
  return { gateway, store, calls, taker };
}

const openMarket = (pricing: Partial<PredictMarket["pricing"]>): PredictMarket => Object.freeze({
  marketId: "mkt-sol-500",
  eventId: null,
  provider: "polymarket",
  status: "open",
  outcomes: ["Yes", "No"],
  pricing: Object.freeze({
    buyYesPriceUnits: null,
    buyNoPriceUnits: null,
    sellYesPriceUnits: null,
    sellNoPriceUnits: null,
    ...pricing,
  }),
  externalIds: Object.freeze([]),
  sourceHash: "aa".repeat(32),
  observedAtMs: 1n,
});

describe("Jupiter Predict order gateway", () => {
  const buyContent = {
    deploymentMode: "hybrid_devnet" as const,
    clientOrderId: "30000000-0000-4000-8000-000000000003:buy:0",
    tokenId: CTF_TOKEN,
    jupiterMarketId: "mkt-sol-500",
    isYes: true,
    side: "buy" as const,
    amountUnits: 6_000_000n,
    worstPriceUnits: 700_000n,
  };

  it("signs, submits, verifies the USDC debit on chain, and replays from the journal", async () => {
    const harness = predictGatewayHarness({
      market: openMarket({ buyYesPriceUnits: 650_000n }),
      contractsMicro: 9_000_000n,
      usdcDeltaUnits: -6_000_000n,
    });
    const request = { ...buyContent, requestHash: hashGatewayPredictOrder(buyContent) };
    const first = await harness.gateway.executeOrder(request);
    assert.equal(first.filledInputUnits, 6_000_000n);
    assert.equal(first.filledOutputUnits, 9_000_000n);
    assert.equal(first.side, "buy");
    assert.equal(harness.calls.sentTransactions.length, 1);
    assert.equal(first.transactionSignature, harness.calls.sentTransactions[0]);
    const replay = await harness.gateway.executeOrder(request);
    assert.deepEqual(replay, first);
    assert.equal(harness.calls.buildOrder, 1);
  });

  it("refuses to sign when the venue quote is already through the worst price", async () => {
    const harness = predictGatewayHarness({
      market: openMarket({ buyYesPriceUnits: 750_000n }),
      contractsMicro: 9_000_000n,
      usdcDeltaUnits: -6_000_000n,
    });
    await assert.rejects(
      harness.gateway.executeOrder({ ...buyContent, requestHash: hashGatewayPredictOrder(buyContent) }),
      /already outside the worst-price policy/u,
    );
    assert.equal(harness.calls.buildOrder, 0);
  });

  it("never signs a transaction that invokes an unapproved program", async () => {
    const harness = predictGatewayHarness({
      market: openMarket({ buyYesPriceUnits: 650_000n }),
      contractsMicro: 9_000_000n,
      usdcDeltaUnits: -6_000_000n,
      buildProgram: new PublicKey(new Uint8Array(32).fill(29)),
    });
    await assert.rejects(
      harness.gateway.executeOrder({ ...buyContent, requestHash: hashGatewayPredictOrder(buyContent) }),
      /unapproved top-level program|never invokes an allowlisted/u,
    );
    assert.equal(harness.calls.sentTransactions.length, 0);
  });

  it("rejects a finalized buy whose average price breaches the bound", async () => {
    const harness = predictGatewayHarness({
      market: openMarket({ buyYesPriceUnits: 650_000n }),
      // 6 USDC for 8 contracts is 75 cents each, above the 70-cent bound.
      contractsMicro: 8_000_000n,
      usdcDeltaUnits: -6_000_000n,
    });
    await assert.rejects(
      harness.gateway.executeOrder({ ...buyContent, requestHash: hashGatewayPredictOrder(buyContent) }),
      /violates the worst-price policy/u,
    );
  });

  it("verifies a sell against the on-chain USDC credit and its proceeds floor", async () => {
    const sellContent = {
      ...buyContent,
      clientOrderId: "30000000-0000-4000-8000-000000000003:sell:0",
      side: "sell" as const,
      amountUnits: 9_000_000n,
      worstPriceUnits: 600_000n,
    };
    const good = predictGatewayHarness({
      market: openMarket({ sellYesPriceUnits: 620_000n }),
      contractsMicro: null,
      usdcDeltaUnits: 5_580_000n,
    });
    const result = await good.gateway.executeOrder({
      ...sellContent,
      requestHash: hashGatewayPredictOrder(sellContent),
    });
    assert.equal(result.filledInputUnits, 9_000_000n);
    assert.equal(result.filledOutputUnits, 5_580_000n);

    const shorted = predictGatewayHarness({
      market: openMarket({ sellYesPriceUnits: 620_000n }),
      contractsMicro: null,
      usdcDeltaUnits: 5_000_000n,
    });
    await assert.rejects(
      shorted.gateway.executeOrder({ ...sellContent, requestHash: hashGatewayPredictOrder(sellContent) }),
      /violates the worst-price policy/u,
    );
  });

  it("fails when the venue never reports the order filled", async () => {
    const harness = predictGatewayHarness({
      market: openMarket({ buyYesPriceUnits: 650_000n }),
      contractsMicro: 9_000_000n,
      usdcDeltaUnits: -6_000_000n,
      orderStatuses: ["created", "created", "created"],
    });
    await assert.rejects(
      harness.gateway.executeOrder({ ...buyContent, requestHash: hashGatewayPredictOrder(buyContent) }),
      /is created, not filled/u,
    );
  });
});

describe("worker-side Predict execution adapter", () => {
  it("maps a gateway fill onto the FAK port and echoes the composition token", async () => {
    const links = new MemoryLinkStore();
    links.links.set(CTF_TOKEN, {
      tokenId: CTF_TOKEN,
      conditionId: CONDITION,
      jupiterMarketId: "mkt-sol-500",
      isYes: true,
      source: "operator",
    });
    const resolver = new JupiterPredictMarketResolver(
      { getMarket: async () => { throw new Error("unexpected"); },
        listCatalogMarkets: async () => { throw new Error("unexpected"); },
        buildOrder: async () => { throw new Error("unexpected"); },
        getOrderStatus: async () => { throw new Error("unexpected"); } },
      links,
    );
    const posted: unknown[] = [];
    const adapter = new HttpJupiterPredictExecution(
      {
        post: async (url: string, body: unknown, schema: z.ZodTypeAny) => {
          posted.push({ url, body });
          const request = body as { requestHash: string };
          return schema.parse({
            requestHash: request.requestHash,
            side: "buy",
            tokenId: CTF_TOKEN,
            jupiterMarketId: "mkt-sol-500",
            orderPubkey: new PublicKey(new Uint8Array(32).fill(23)).toBase58(),
            positionPubkey: null,
            outputMint: null,
            requestedAmountUnits: "6000000",
            filledInputUnits: "6000000",
            filledOutputUnits: "9000000",
            transactionSignature: "s".repeat(64),
            finalizedSlot: "77",
            executedAtMs: "1000",
          });
        },
      } as unknown as JsonHttpClient,
      resolver,
      {
        baseUrl: "http://127.0.0.1:3002",
        bearerToken: "gateway-test-token-0123456789abcdef",
        deploymentMode: "hybrid_devnet",
        allowInsecureLocalhost: true,
      },
    );
    const result = await adapter.executeFak({
      clientOrderId: "30000000-0000-4000-8000-000000000003:buy:0",
      tokenId: CTF_TOKEN,
      side: "buy",
      negativeRisk: false,
      amountUnits: 6_000_000n,
      worstPriceUnits: 700_000n,
    });
    assert.equal(result.tokenId, CTF_TOKEN);
    assert.equal(result.filledInputUnits, 6_000_000n);
    assert.equal(result.filledOutputUnits, 9_000_000n);
    assert.equal(result.status, "matched");
    assert.deepEqual(result.transactionHashes, ["s".repeat(64)]);
    const body = (posted[0] as { body: Record<string, unknown> }).body;
    assert.equal(body.jupiterMarketId, "mkt-sol-500");
    assert.equal(body.isYes, true);
  });
});

describe("Jupiter Predict venue workflows", () => {
  it("funds a mixed deposit at one Solana destination, skips the bridge, and keeps idle cash as USDC", async () => {
    const user = userSigner();
    const settlementWallet = new PublicKey(new Uint8Array(32).fill(32)).toBase58();
    const feeDestination = new PublicKey(new Uint8Array(32).fill(10)).toBase58();
    const spotMints = [33, 34, 35].map((fill) => new PublicKey(new Uint8Array(32).fill(fill)));
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
    const intent = new IntentSubmissionService().submitDeposit({
      quote,
      nonce: 3n,
      signature: user.sign(depositIntentMessage({
        basket,
        user: user.publicKey,
        intentNonce: 3n,
        intentExpiry: quote.expiresAtSeconds,
        expectedCompositionVersion: 1,
        grossAmount: quote.grossAmount,
        minSharesOut: quote.minSharesOut,
        quoteHash: quote.quoteHash,
      })),
      nowSeconds,
    });
    const verified = new Map<string, bigint>();
    const workflow = new DepositWorkflow(
      new InMemoryExecutionOperationStore(),
      throwingBridge,
      { verifyPusdCredit: async () => { throw new Error("Polygon credit must not be verified"); } },
      { verifyFinalizedTransfer: async (request) => {
        const previous = verified.get(request.expectedBridgeAddress);
        if (previous !== undefined && previous !== request.expectedAmountUnits) {
          throw new Error(`destination ${request.expectedBridgeAddress} verified with different amounts`);
        }
        verified.set(request.expectedBridgeAddress, request.expectedAmountUnits);
        return {
          signature: request.signature,
          user: request.expectedUser,
          bridgeAddress: request.expectedBridgeAddress,
          mint: request.expectedMint,
          amountUnits: request.expectedAmountUnits,
          finalizedSlot: 2n,
        };
      } },
      { executeFak: async (request) => ({
        clientOrderId: request.clientOrderId,
        orderId: `order-${request.clientOrderId}`,
        tokenId: request.tokenId,
        side: request.side,
        requestedAmountUnits: request.amountUnits,
        filledInputUnits: request.amountUnits - 1_000n,
        filledOutputUnits: (request.amountUnits - 1_000n) * 2n,
        averagePriceUnits: 500_000n,
        status: "partially_filled",
        transactionHashes: [`predict-${request.clientOrderId}`],
        tradeIds: [],
        executedAtMs: nowSeconds * 1_000n,
      }) },
      { loadLatestPricing: async () => ({
        navReportHash: navHash,
        basketNavValue: quote.basketNavValue,
        sharePrice: quote.sharePrice,
        observedAtSeconds: nowSeconds,
      }) },
      {
        completeDeposit: async () => ({ transactionSignature: "settled", receiptAddress: "receipt", finalizedSlot: 9n }),
        completeWithdrawal: async () => { throw new Error("unexpected"); },
        completeProtocolFeeWithdrawal: async () => { throw new Error("unexpected"); },
      },
      executionGuard,
      walletCoordinator,
      undefined,
      { executeExactIn: async (request) => ({
        idempotencyKey: request.idempotencyKey,
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        requestedInputUnits: request.inputAmountUnits,
        filledInputUnits: request.inputAmountUnits - 1_000n,
        filledOutputUnits: request.inputAmountUnits * 3n,
        minimumOutputUnits: 1n,
        transactionSignature: `swap-${request.idempotencyKey}`,
        finalizedSlot: 5n,
        executedAtMs: nowSeconds * 1_000n,
        status: "partially_filled",
      }) },
    );
    const result = await workflow.execute({
      operationId: "40000000-0000-4000-8000-000000000004",
      requestKey: "predict-deposit-1",
      workflowId: "predict-deposit-1",
      intent,
      polymarketWallet: `0x${"55".repeat(20)}`,
      walletId: "wallet-predict",
      preparedBridgeAddress: settlementWallet,
      solanaUsdcMint: usdcMint.toBase58(),
      protocolFeeDestination: feeDestination,
      spotFundingDestination: settlementWallet,
      fundingTransactionSignature: "solana-funding-predict",
      maxSlippageBps: 100,
      predictionVenue: "jupiter_predict",
      targets: [
        { tokenId: CTF_TOKEN, weightBps: 2_000, worstBuyPriceUnits: 600_000n, negativeRisk: false, conditionId: CONDITION, outcomeIndex: 0 },
        { tokenId: "222222222222", weightBps: 2_000, worstBuyPriceUnits: 600_000n, negativeRisk: false },
        ...spotMints.map((mint) => ({
          kind: "spot" as const,
          tokenId: mint.toBase58(),
          tokenMint: mint.toBase58(),
          weightBps: 2_000,
        })),
      ],
      settlementNonce: 1n,
      capitalMode: "live_bridge",
      now: NOW,
    });
    // 995,000 net: 398,000 prediction + 597,000 spot, all at the settlement
    // wallet in one verified delta; the fee is its own destination.
    assert.deepEqual([...verified.entries()].sort(), [
      [feeDestination, 5_000n],
      [settlementWallet, 995_000n],
    ].sort());
    assert.equal(result.idlePusdUnits, 0n);
    // 2 predict legs and 3 spot legs each left 1,000 unspent.
    assert.equal(result.idleUsdcUnits, 5_000n);
    assert.equal(result.netDepositValue, 995_000n);
    assert.equal(result.operation.state, "completed");
    // A replay of the same operation never re-prepares through the bridge and
    // reproduces the identical execution batch.
    const replay = await workflow.execute({
      operationId: "40000000-0000-4000-8000-000000000004",
      requestKey: "predict-deposit-1",
      workflowId: "predict-deposit-1",
      intent,
      polymarketWallet: `0x${"55".repeat(20)}`,
      walletId: "wallet-predict",
      preparedBridgeAddress: settlementWallet,
      solanaUsdcMint: usdcMint.toBase58(),
      protocolFeeDestination: feeDestination,
      spotFundingDestination: settlementWallet,
      fundingTransactionSignature: "solana-funding-predict",
      maxSlippageBps: 100,
      predictionVenue: "jupiter_predict",
      targets: [
        { tokenId: CTF_TOKEN, weightBps: 2_000, worstBuyPriceUnits: 600_000n, negativeRisk: false, conditionId: CONDITION, outcomeIndex: 0 },
        { tokenId: "222222222222", weightBps: 2_000, worstBuyPriceUnits: 600_000n, negativeRisk: false },
        ...spotMints.map((mint) => ({
          kind: "spot" as const,
          tokenId: mint.toBase58(),
          tokenMint: mint.toBase58(),
          weightBps: 2_000,
        })),
      ],
      settlementNonce: 1n,
      capitalMode: "live_bridge",
      now: NOW,
    });
    assert.equal(replay.executionBatchHash, result.executionBatchHash);
  });

  it("withdraws through Predict sales, claiming them as the split's capital sources", async () => {
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
    const intent = new IntentSubmissionService().submitWithdrawal({
      quote,
      nonce: 4n,
      destination,
      signature: user.sign(withdrawalIntentMessage({
        basket,
        user: user.publicKey,
        intentNonce: 4n,
        intentExpiry: quote.expiresAtSeconds,
        expectedCompositionVersion: 1,
        shareAmount: quote.shareAmount,
        minValueOut: quote.minValueOut,
        destination,
        quoteHash: quote.quoteHash,
      })),
      nowSeconds,
    });
    type SplitRequest = Parameters<SolanaAtomicSplitPort["distribute"]>[0];
    let splitRequest: SplitRequest | undefined;
    const workflow = new WithdrawalWorkflow(
      new InMemoryExecutionOperationStore(),
      { executeFak: async (request) => ({
        clientOrderId: request.clientOrderId,
        orderId: `order-${request.clientOrderId}`,
        tokenId: request.tokenId,
        side: "sell",
        requestedAmountUnits: request.amountUnits,
        filledInputUnits: request.amountUnits,
        filledOutputUnits: request.amountUnits,
        averagePriceUnits: 999_999n,
        status: "matched",
        transactionHashes: [`predict-sale-${request.clientOrderId.slice(-1)}`],
        tradeIds: [],
        executedAtMs: nowSeconds * 1_000n,
      }) },
      throwingBridge,
      { transferPusd: async () => { throw new Error("pUSD must not move on the Jupiter Predict venue"); } },
      { verifyReceived: async () => { throw new Error("no bridge receipt exists on the Jupiter Predict venue"); } },
      { distribute: async (request) => {
        splitRequest = request;
        return { transactionSignature: "split", finalizedSlot: 11n };
      } },
      { loadLatestPricing: async () => ({
        navReportHash: navHash,
        basketNavValue: quote.basketNavValue,
        sharePrice: quote.sharePrice,
        observedAtSeconds: nowSeconds,
      }) },
      {
        completeDeposit: async () => { throw new Error("unexpected deposit"); },
        completeWithdrawal: async () => ({ transactionSignature: "settled", receiptAddress: "receipt", finalizedSlot: 12n }),
        completeProtocolFeeWithdrawal: async () => { throw new Error("unexpected"); },
      },
      executionGuard,
      walletCoordinator,
    );
    const request = {
      operationId: "50000000-0000-4000-8000-000000000005",
      requestKey: "predict-withdrawal-1",
      workflowId: "predict-withdrawal-1",
      intent,
      polymarketWallet: `0x${"66".repeat(20)}`,
      walletId: "wallet-predict",
      totalSharesOutstanding: 100_000_000n,
      positionSharesOwned: 100_000_000n,
      positionCostBasisValue: 50_000_000n,
      weightedDepositTimestamp: nowSeconds - 2_592_000n,
      idlePusdUnits: 0n,
      predictionVenue: "jupiter_predict" as const,
      targets: [
        { tokenId: "a", weightBps: 2_500, currentUnits: 25_000_000n, worstSellPriceUnits: 800_000n, negativeRisk: false },
        { tokenId: "b", weightBps: 2_500, currentUnits: 25_000_000n, worstSellPriceUnits: 800_000n, negativeRisk: false },
        { tokenId: "c", weightBps: 2_500, currentUnits: 25_000_000n, worstSellPriceUnits: 800_000n, negativeRisk: false },
        { tokenId: "d", weightBps: 2_500, currentUnits: 25_000_000n, worstSellPriceUnits: 800_000n, negativeRisk: false },
      ],
      performanceFeeBps: 1_000,
      maxSlippageBps: 0,
      creatorDestination: new PublicKey(new Uint8Array(32).fill(14)).toBase58(),
      protocolDestination: new PublicKey(new Uint8Array(32).fill(15)).toBase58(),
      solanaSettlementReceiver: new PublicKey(new Uint8Array(32).fill(16)).toBase58(),
      solanaUsdcMint: usdcMint.toBase58(),
      solanaChainId: "solana-native",
      settlementNonce: 2n,
      now: NOW,
    } as const;
    const result = await workflow.execute(request);
    assert.equal(result.grossRealizedValue, 10_000_000n);
    assert.equal(result.bridgeTransaction, null);
    assert.notEqual(splitRequest, undefined);
    const split = splitRequest as SplitRequest;
    assert.equal(split.sourceBridgeTransaction, null);
    assert.equal(split.sourceBridgeAmountUnits, 0n);
    assert.deepEqual(split.sourcePredictTransactions, [
      "predict-sale-0",
      "predict-sale-1",
      "predict-sale-2",
      "predict-sale-3",
    ]);
    assert.equal(
      split.userAmountUnits + split.creatorAmountUnits + split.protocolAmountUnits,
      10_000_000n,
    );

    await assert.rejects(
      workflow.execute({ ...request, operationId: "50000000-0000-4000-8000-000000000006", requestKey: "predict-withdrawal-2", idlePusdUnits: 1n }),
      /idle pUSD/u,
    );
  });
});

describe("quote-layer prediction venue guard", () => {
  const programId = new PublicKey(new Uint8Array(32).fill(40));
  const protocolFeeDestination = new PublicKey(new Uint8Array(32).fill(41)).toBase58();
  const settlementMint = new PublicKey(new Uint8Array(32).fill(42)).toBase58();
  const nowMs = 1_756_720_000_000n;

  const executor: SqlExecutor = {
    query: async <Row extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
      if (sql.includes("nav_snapshots")) {
        return { rows: [{
          snapshot_hash: "cd".repeat(32),
          observed_at_ms: nowMs.toString(10),
          snapshot: { grossNavPusdUnits: "10000000", sharePriceUnits: "1000000" },
        }] as unknown as Row[], rowCount: 1 };
      }
      if (sql.includes("'Position'")) return { rows: [] as Row[], rowCount: 0 };
      if (params?.[1] === "Basket") {
        return { rows: [{ account_data: {
          status: { active: {} },
          compositionVersion: 1,
          performanceFeeBps: 1000,
          protocolFeeDestination,
          hasInitializedSharePrice: true,
          totalSharesOutstanding: "1000000",
          items: [0, 1, 2, 3].map((index) => ({
            marketId: `market-${index}`,
            weightBps: 2500,
            kind: { predictionMarket: { outcome: index % 2, ctfTokenId: "ab".repeat(32) } },
          })),
        } }] as unknown as Row[], rowCount: 1 };
      }
      if (params?.[1] === "Config") {
        return { rows: [{ account_data: {
          maxSlippageBps: 1000,
          settlementMint,
        } }] as unknown as Row[], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
  const sql: SqlClient = {
    ...executor,
    transaction: async (operation) => operation(executor),
  } as SqlClient;

  it("refuses prediction baskets when no venue is enabled and passes them when one is", async () => {
    const disabled = new PostgresQuoteContextStore(sql, programId, 60_000n, {
      nowMs: () => nowMs,
      predictionVenue: "disabled",
    });
    await assert.rejects(
      disabled.loadLatest(basket, new PublicKey(new Uint8Array(32).fill(43))),
      (error: unknown) =>
        error instanceof ApiRequestError && error.code === "prediction_venue_disabled",
    );

    const enabled = new PostgresQuoteContextStore(sql, programId, 60_000n, {
      nowMs: () => nowMs,
      predictionVenue: "jupiter_predict",
    });
    const context = await enabled.loadLatest(basket, new PublicKey(new Uint8Array(32).fill(43)));
    assert.deepEqual(
      context.executionAssets?.map((asset) => asset.kind),
      ["prediction_market", "prediction_market", "prediction_market", "prediction_market"],
    );
  });
});

describe("Solana split with Predict capital sources", () => {
  const sourceOwner = new PublicKey(new Uint8Array(32).fill(50));
  const destinations = [51, 52, 53].map((fill) => new PublicKey(new Uint8Array(32).fill(fill)).toBase58());
  const buildSentinel = new Error("reached transaction build");

  function splitHarness() {
    const store = new MemoryGatewayStore();
    const finalizePredict = (reference: string, result: Record<string, unknown>): void => {
      store.entries.set(`seed:${reference}`, Object.freeze({
        requestKey: `seed:${reference}`,
        requestKind: "predict_order" as const,
        requestHash: "ee".repeat(32),
        signedPayload: new Uint8Array([1]),
        transactionReference: reference,
        state: "finalized" as const,
        result: Object.freeze(result),
      }));
    };
    const gateway = new SolanaUsdcSplitGateway(
      store,
      { sign: async () => { throw new Error("signer must not be reached"); } } as unknown as PolicyEnforcedSignerType,
      { getParsedAccountInfo: async () => { throw buildSentinel; } } as never,
      {
        deploymentMode: "hybrid_devnet",
        sourceOwner,
        usdcMint,
        maximumSplitUnits: 100_000_000n,
        maximumNetworkFeeLamports: 10_000_000n,
        now: () => NOW,
      },
    );
    return { store, gateway, finalizePredict };
  }

  /**
   * The worker computes the request hash client-side; capture exactly what
   * HttpSolanaAtomicSplit would send so the gateway's canonical hash is pinned
   * against the client encoder, predict sources included.
   */
  async function clientHashedRequest(request: {
    readonly idempotencyKey: string;
    readonly sourceJupiterTransactions?: readonly string[];
    readonly sourcePredictTransactions?: readonly string[];
    readonly idleUsdcAmountUnits?: bigint;
    readonly userAmountUnits: bigint;
    readonly creatorAmountUnits: bigint;
    readonly protocolAmountUnits: bigint;
  }) {
    let captured: { requestHash: string } | undefined;
    const client = new HttpSolanaAtomicSplit(
      { post: async (_url: string, body: unknown) => {
        captured = body as { requestHash: string };
        throw new Error("captured");
      } } as unknown as JsonHttpClient,
      {
        baseUrl: "http://127.0.0.1:3002",
        bearerToken: "gateway-test-token-0123456789abcdef",
        deploymentMode: "hybrid_devnet",
        allowInsecureLocalhost: true,
      },
    );
    await client.distribute({
      idempotencyKey: request.idempotencyKey,
      sourceBridgeTransaction: null,
      sourceBridgeAmountUnits: 0n,
      sourceJupiterTransactions: request.sourceJupiterTransactions ?? [],
      ...(request.sourcePredictTransactions === undefined
        ? {}
        : { sourcePredictTransactions: request.sourcePredictTransactions }),
      idleUsdcAmountUnits: request.idleUsdcAmountUnits ?? 0n,
      mint: usdcMint.toBase58(),
      userDestination: destinations[0] as string,
      creatorDestination: destinations[1] as string,
      protocolDestination: destinations[2] as string,
      userAmountUnits: request.userAmountUnits,
      creatorAmountUnits: request.creatorAmountUnits,
      protocolAmountUnits: request.protocolAmountUnits,
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "captured") throw error;
    });
    assert.notEqual(captured, undefined);
    return {
      requestHash: (captured as { requestHash: string }).requestHash,
      deploymentMode: "hybrid_devnet" as const,
      idempotencyKey: request.idempotencyKey,
      sourceBridgeTransaction: null,
      sourceBridgeAmountUnits: 0n,
      sourceJupiterTransactions: request.sourceJupiterTransactions ?? [],
      ...(request.sourcePredictTransactions === undefined
        ? {}
        : { sourcePredictTransactions: request.sourcePredictTransactions }),
      idleUsdcAmountUnits: request.idleUsdcAmountUnits ?? 0n,
      mint: usdcMint.toBase58(),
      userDestination: destinations[0] as string,
      creatorDestination: destinations[1] as string,
      protocolDestination: destinations[2] as string,
      userAmountUnits: request.userAmountUnits,
      creatorAmountUnits: request.creatorAmountUnits,
      protocolAmountUnits: request.protocolAmountUnits,
    };
  }

  const saleA = "a".repeat(64);
  const saleB = "b".repeat(64);

  it("accepts journaled Predict sales as sources with the client-computed hash", async () => {
    const { gateway, finalizePredict } = splitHarness();
    finalizePredict(saleA, { side: "sell", outputMint: usdcMint.toBase58(), filledOutputUnits: "3000000" });
    finalizePredict(saleB, { side: "sell", outputMint: usdcMint.toBase58(), filledOutputUnits: "2000000" });
    const request = await clientHashedRequest({
      idempotencyKey: "predict-split-0001",
      sourcePredictTransactions: [saleA, saleB],
      idleUsdcAmountUnits: 1_000_000n,
      userAmountUnits: 5_000_000n,
      creatorAmountUnits: 500_000n,
      protocolAmountUnits: 500_000n,
    });
    // Reaching the transaction build proves the canonical hash matched the
    // client encoder and every source reconciled; nothing signs in this test.
    await assert.rejects(gateway.splitSolanaUsdc(request), /reached transaction build/u);
  });

  it("refuses a Predict source that is missing, is a buy, or double-counts", async () => {
    const { gateway, finalizePredict } = splitHarness();
    finalizePredict(saleA, { side: "sell", outputMint: usdcMint.toBase58(), filledOutputUnits: "3000000" });
    finalizePredict(saleB, { side: "buy", outputMint: null, filledOutputUnits: "2000000" });

    await assert.rejects(
      gateway.splitSolanaUsdc(await clientHashedRequest({
        idempotencyKey: "predict-split-0002",
        sourcePredictTransactions: ["c".repeat(64)],
        userAmountUnits: 1_000_000n,
        creatorAmountUnits: 0n,
        protocolAmountUnits: 0n,
      })),
      /absent from the finalized gateway journal/u,
    );

    await assert.rejects(
      gateway.splitSolanaUsdc(await clientHashedRequest({
        idempotencyKey: "predict-split-0003",
        sourcePredictTransactions: [saleB],
        userAmountUnits: 2_000_000n,
        creatorAmountUnits: 0n,
        protocolAmountUnits: 0n,
      })),
      /not a USDC sale/u,
    );

    await assert.rejects(
      gateway.splitSolanaUsdc(await clientHashedRequest({
        idempotencyKey: "predict-split-0004",
        sourceJupiterTransactions: [saleA],
        sourcePredictTransactions: [saleA],
        userAmountUnits: 6_000_000n,
        creatorAmountUnits: 0n,
        protocolAmountUnits: 0n,
      })),
      /duplicate capital source proofs/u,
    );

    await assert.rejects(
      gateway.splitSolanaUsdc(await clientHashedRequest({
        idempotencyKey: "predict-split-0005",
        sourcePredictTransactions: [saleA],
        userAmountUnits: 9_000_000n,
        creatorAmountUnits: 0n,
        protocolAmountUnits: 0n,
      })),
      /do not reconcile/u,
    );
  });
});

describe("execution gateway HTTP predict route", () => {
  const bearerToken = "gateway-http-test-token-0123456789abcdef";
  const orderBody = {
    requestHash: "ab".repeat(32),
    deploymentMode: "hybrid_devnet",
    clientOrderId: "60000000-0000-4000-8000-000000000006:buy:0",
    tokenId: CTF_TOKEN,
    jupiterMarketId: "mkt-sol-500",
    isYes: true,
    side: "buy",
    amountUnits: "6000000",
    worstPriceUnits: "700000",
  };

  async function postOrder(service: ExecutionGatewayServicePort) {
    const server = createExecutionGatewayHttpServer({ service, bearerToken });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/predict/order`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "x-alphabasket-request-version": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify(orderBody),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const unreachable = () => { throw new Error("unexpected gateway call"); };

  it("serves predict orders with big integers serialized as strings", async () => {
    const { status, body } = await postOrder({
      signFakOrder: unreachable,
      transferPusd: unreachable,
      splitSolanaUsdc: unreachable,
      executePredictOrder: async (request) => ({
        requestHash: request.requestHash,
        side: request.side,
        tokenId: request.tokenId,
        jupiterMarketId: request.jupiterMarketId,
        orderPubkey: new PublicKey(new Uint8Array(32).fill(23)).toBase58(),
        positionPubkey: null,
        requestedAmountUnits: request.amountUnits,
        filledInputUnits: request.amountUnits,
        filledOutputUnits: 9_000_000n,
        transactionSignature: "t".repeat(64),
        finalizedSlot: 77n,
        executedAtMs: 1_000n,
      }),
    });
    assert.equal(status, 200);
    assert.equal(body.filledOutputUnits, "9000000");
    assert.equal(body.requestedAmountUnits, "6000000");
    assert.equal(body.finalizedSlot, "77");
  });

  it("answers 404 when the venue is not enabled on the gateway", async () => {
    const { status, body } = await postOrder({
      signFakOrder: unreachable,
      transferPusd: unreachable,
      splitSolanaUsdc: unreachable,
    });
    assert.equal(status, 404);
    assert.equal(body.error, "predict_execution_disabled");
  });
});

describe("Jupiter Predict protocol-fee redemption", () => {
  it("liquidates protocol shares Solana-natively and claims Predict sales in the transfer", async () => {
    type SplitRequest = Parameters<SolanaAtomicSplitPort["distribute"]>[0];
    let transferRequest: SplitRequest | undefined;
    const workflow = new ProtocolFeeWithdrawalWorkflow(
      new InMemoryExecutionOperationStore(),
      { executeFak: async (request) => ({
        clientOrderId: request.clientOrderId,
        orderId: `order-${request.clientOrderId}`,
        tokenId: request.tokenId,
        side: "sell",
        requestedAmountUnits: request.amountUnits,
        filledInputUnits: request.amountUnits,
        filledOutputUnits: request.amountUnits,
        averagePriceUnits: 999_999n,
        status: "matched",
        transactionHashes: [`protocol-sale-${request.clientOrderId.slice(-1)}`],
        tradeIds: [],
        executedAtMs: nowSeconds * 1_000n,
      }) },
      throwingBridge,
      { transferPusd: async () => { throw new Error("pUSD must not move on the Jupiter Predict venue"); } },
      { verifyReceived: async () => { throw new Error("no bridge receipt exists on the Jupiter Predict venue"); } },
      { distribute: async (request) => {
        transferRequest = request;
        return { transactionSignature: "protocol-transfer", finalizedSlot: 11n };
      } },
      { loadLatestPricing: async () => ({
        navReportHash: navHash,
        basketNavValue: 100_000_000n,
        sharePrice: 1_000_000n,
        observedAtSeconds: nowSeconds,
      }) },
      {
        completeDeposit: async () => { throw new Error("unexpected deposit"); },
        completeWithdrawal: async () => { throw new Error("unexpected withdrawal"); },
        completeProtocolFeeWithdrawal: async () => ({
          transactionSignature: "protocol-settled",
          receiptAddress: "receipt",
          finalizedSlot: 12n,
        }),
      },
      executionGuard,
      walletCoordinator,
    );
    const request = {
      operationId: "70000000-0000-4000-8000-000000000007",
      requestKey: "predict-protocol-1",
      workflowId: "predict-protocol-1",
      basket,
      navReportHash: navHash,
      basketNavValue: 100_000_000n,
      sharePrice: 1_000_000n,
      shareAmount: 10_000_000n,
      protocolFeeShares: 10_000_000n,
      totalSharesOutstanding: 100_000_000n,
      idlePusdUnits: 0n,
      idleUsdcUnits: 0n,
      predictionVenue: "jupiter_predict" as const,
      targets: [
        { tokenId: "a", weightBps: 2_500, currentUnits: 25_000_000n, worstSellPriceUnits: 800_000n, negativeRisk: false },
        { tokenId: "b", weightBps: 2_500, currentUnits: 25_000_000n, worstSellPriceUnits: 800_000n, negativeRisk: false },
        { tokenId: "c", weightBps: 2_500, currentUnits: 25_000_000n, worstSellPriceUnits: 800_000n, negativeRisk: false },
        { tokenId: "d", weightBps: 2_500, currentUnits: 25_000_000n, worstSellPriceUnits: 800_000n, negativeRisk: false },
      ],
      maxSlippageBps: 0,
      polymarketWallet: `0x${"77".repeat(20)}`,
      walletId: "wallet-protocol-predict",
      protocolDestination: new PublicKey(new Uint8Array(32).fill(15)).toBase58(),
      solanaSettlementReceiver: new PublicKey(new Uint8Array(32).fill(16)).toBase58(),
      solanaUsdcMint: usdcMint.toBase58(),
      solanaChainId: "solana-native",
      settlementNonce: 3n,
      now: NOW,
    } as const;
    const result = await workflow.execute(request);
    assert.equal(result.grossRealizedValue, 10_000_000n);
    assert.notEqual(transferRequest, undefined);
    const transfer = transferRequest as SplitRequest;
    assert.equal(transfer.sourceBridgeTransaction, null);
    assert.equal(transfer.sourceBridgeAmountUnits, 0n);
    assert.deepEqual(transfer.sourcePredictTransactions, [
      "protocol-sale-0",
      "protocol-sale-1",
      "protocol-sale-2",
      "protocol-sale-3",
    ]);
    assert.equal(transfer.protocolAmountUnits, 10_000_000n);

    await assert.rejects(
      workflow.execute({
        ...request,
        operationId: "70000000-0000-4000-8000-000000000008",
        requestKey: "predict-protocol-2",
        idlePusdUnits: 1n,
      }),
      /idle pUSD/u,
    );
  });
});

describe("remaining venue guards", () => {
  it("rejects a non-positive Predict minimum order in configuration", () => {
    assert.throws(
      () => loadBackendConfig({
        ...baseEnvironment,
        JUPITER_PREDICT_MINIMUM_ORDER_UNITS: "0",
      }),
      /JUPITER_PREDICT_MINIMUM_ORDER_UNITS must be positive/u,
    );
  });

  it("refuses market data for a market that is no longer open", async () => {
    const links = new MemoryLinkStore();
    links.links.set(CTF_TOKEN, {
      tokenId: CTF_TOKEN,
      conditionId: CONDITION,
      jupiterMarketId: "mkt-resolved",
      isYes: true,
      source: "operator",
    });
    const data = new JupiterPredictMarketData(
      new JupiterPredictRest(
        fakeHttp({
          "GET https://api.jup.ag/prediction/v1/markets/mkt-resolved": {
            marketId: "mkt-resolved",
            status: "resolved",
            outcomes: ["Yes", "No"],
            pricing: null,
          },
        }),
        { apiKey: "test" },
      ),
      links,
      { minimumOrderUnits: 5_000_000n },
    );
    await assert.rejects(data.getOrderBook(CTF_TOKEN), /is resolved, not open/u);
  });

  it("gates gateway orders on deployment mode and the venue minimum", async () => {
    const harness = predictGatewayHarness({
      market: openMarket({ buyYesPriceUnits: 650_000n }),
      contractsMicro: 9_000_000n,
      usdcDeltaUnits: -6_000_000n,
    });
    const content = {
      deploymentMode: "hybrid_devnet" as const,
      clientOrderId: "80000000-0000-4000-8000-000000000009:buy:0",
      tokenId: CTF_TOKEN,
      jupiterMarketId: "mkt-sol-500",
      isYes: true,
      side: "buy" as const,
      amountUnits: 4_000_000n,
      worstPriceUnits: 700_000n,
    };
    await assert.rejects(
      harness.gateway.executeOrder({ ...content, requestHash: hashGatewayPredictOrder(content) }),
      /outside the gateway policy/u,
    );
    const wrongMode = { ...content, deploymentMode: "production" as const, amountUnits: 6_000_000n };
    await assert.rejects(
      harness.gateway.executeOrder({ ...wrongMode, requestHash: hashGatewayPredictOrder(wrongMode) }),
      /deployment mode does not match/u,
    );
    assert.equal(harness.calls.buildOrder, 0);
  });
});
