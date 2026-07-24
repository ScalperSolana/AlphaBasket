import { randomUUID } from "node:crypto";

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import {
  BasketCreationOrchestrator,
  type ComposerCandidate,
  type ComposerPolicy,
} from "../composer/index.js";
import { executionRequestHash } from "../execution/hashes.js";
import type { ExecutionKind, ExecutionState } from "../execution/types.js";
import {
  IntentSubmissionService,
  QuoteService,
  type DepositQuote,
  type SignedDepositIntent,
  type SignedWithdrawalIntent,
  type WithdrawalQuote,
} from "../quotes/index.js";
import { deterministicWorkflowId } from "../workflows/index.js";
import {
  ApiRequestError,
  type ApiJsonObject,
  type ApiJsonValue,
  type FinancialApiPort,
} from "./api-types.js";

const canonicalUnsigned = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/u)
  .transform((value) => BigInt(value));
const positiveUnsigned = canonicalUnsigned.refine((value) => value > 0n);
const hex32 = z.string().regex(/^[0-9a-f]{64}$/u);
const base64 = z
  .string()
  .min(4)
  .max(8_192)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
const operationIdSchema = z.string().uuid();

const publicKey = z.string().transform((value, context) => {
  try {
    return new PublicKey(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid Solana public key" });
    return z.NEVER;
  }
});

const bytes32 = hex32.transform((value) => Buffer.from(value, "hex"));
const quoteCommonSchema = z.object({
  quoteHash: bytes32,
  basket: publicKey,
  user: publicKey,
  compositionVersion: z.number().int().positive().max(0xffff_ffff),
  navReportHash: bytes32,
  basketNavValue: canonicalUnsigned,
  sharePrice: positiveUnsigned,
  maxSlippageBps: z.number().int().min(0).max(10_000),
  expiresAtSeconds: positiveUnsigned,
}).strict();

const depositQuoteSchema = quoteCommonSchema.extend({
  kind: z.literal("deposit"),
  grossAmount: positiveUnsigned,
  protocolFee: canonicalUnsigned,
  quotedNetValue: positiveUnsigned,
  minimumNetValue: positiveUnsigned,
  minSharesOut: positiveUnsigned,
}).strict();

const withdrawalQuoteSchema = quoteCommonSchema.extend({
  kind: z.literal("withdrawal"),
  shareAmount: positiveUnsigned,
  quotedGrossValue: positiveUnsigned,
  minimumGrossValue: positiveUnsigned,
  minValueOut: canonicalUnsigned,
  quotedProtocolFee: canonicalUnsigned,
  quotedCreatorFee: canonicalUnsigned,
}).strict();

const createDepositQuoteSchema = z.object({
  basket: publicKey,
  user: publicKey,
  grossAmount: positiveUnsigned,
  maxSlippageBps: z.number().int().min(0).max(10_000),
  expiresAtSeconds: positiveUnsigned,
}).strict();

const createWithdrawalQuoteSchema = z.object({
  basket: publicKey,
  user: publicKey,
  shareAmount: positiveUnsigned,
  maxSlippageBps: z.number().int().min(0).max(10_000),
  expiresAtSeconds: positiveUnsigned,
}).strict();

const submitDepositIntentSchema = z.object({
  quote: depositQuoteSchema,
  nonce: positiveUnsigned,
  signature: base64,
}).strict();

const submitWithdrawalIntentSchema = z.object({
  quote: withdrawalQuoteSchema,
  nonce: positiveUnsigned,
  destination: publicKey,
  signature: base64,
}).strict();

const submitFundingSchema = z.object({
  transactionSignature: z.string().min(32).max(128),
}).strict();

const candidateSchema = z.object({
  marketId: z.string().min(1).max(64),
  conditionId: z.string().regex(/^0x[0-9a-f]{64}$/u),
  eventId: z.string().min(1).max(128).nullable(),
  tokenId: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  outcomeLabel: z.string().min(1).max(128),
  outcomeIndex: z.union([z.literal(0), z.literal(1)]),
  active: z.boolean(),
  closed: z.boolean(),
  acceptingOrders: z.boolean(),
  endTimeMs: canonicalUnsigned.nullable(),
  thematicallyRelevant: z.boolean(),
  outcomeClear: z.boolean(),
  classificationSource: z.string().min(1).max(256),
  hasBid: z.boolean(),
  hasAsk: z.boolean(),
  spreadBps: z.number().int().min(0).max(10_000),
  midpointPriceUnits: canonicalUnsigned,
  depthPusdUnits: canonicalUnsigned,
  volume24hPusdUnits: canonicalUnsigned,
  dataCondition: z.enum(["fresh", "stale", "illiquid", "unavailable"]),
}).strict();

const policySchema = z.object({
  minMarkets: z.number().int().positive().max(64),
  maxMarkets: z.number().int().positive().max(64),
  minRemainingMs: canonicalUnsigned,
  maxRemainingMs: canonicalUnsigned,
  maxSpreadBps: z.number().int().min(0).max(10_000),
  minDepthPusdUnits: canonicalUnsigned,
  minVolume24hPusdUnits: canonicalUnsigned,
}).strict();

const createBasketSchema = z.object({
  basketId: hex32,
  creator: publicKey,
  creatorFeeDestination: publicKey,
  isPerpetual: z.boolean(),
  reconstitutionCadenceSecs: canonicalUnsigned,
  compositionNonce: positiveUnsigned,
  compositionExpiry: positiveUnsigned,
  performanceFeeBps: z.number().int().min(0).max(2_000).optional(),
  candidates: z.array(candidateSchema).min(1).max(64),
  policy: policySchema,
}).strict();

function decodeSignature(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.byteLength !== 64) {
    throw new ApiRequestError(400, "invalid_signature", "signature must be canonical base64 for exactly 64 bytes");
  }
  return Uint8Array.from(bytes);
}

function parse<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiRequestError(
      400,
      "invalid_request",
      result.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "),
    );
  }
  return result.data;
}

function validateIdempotencyKey(value: string): void {
  if (value.length < 8 || value.length > 128 || !/^[A-Za-z0-9_.:-]+$/u.test(value)) {
    throw new ApiRequestError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must contain 8-128 URL-safe characters",
    );
  }
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1_000));
}

function quoteJson(quote: DepositQuote | WithdrawalQuote): ApiJsonObject {
  const common = {
    quoteHash: quote.quoteHash.toString("hex"),
    basket: quote.basket.toBase58(),
    user: quote.user.toBase58(),
    compositionVersion: quote.compositionVersion,
    navReportHash: quote.navReportHash.toString("hex"),
    basketNavValue: quote.basketNavValue.toString(10),
    sharePrice: quote.sharePrice.toString(10),
    maxSlippageBps: quote.maxSlippageBps,
    expiresAtSeconds: quote.expiresAtSeconds.toString(10),
  };
  return quote.kind === "deposit"
    ? {
        ...common,
        kind: quote.kind,
        grossAmount: quote.grossAmount.toString(10),
        protocolFee: quote.protocolFee.toString(10),
        quotedNetValue: quote.quotedNetValue.toString(10),
        minimumNetValue: quote.minimumNetValue.toString(10),
        minSharesOut: quote.minSharesOut.toString(10),
      }
    : {
        ...common,
        kind: quote.kind,
        shareAmount: quote.shareAmount.toString(10),
        quotedGrossValue: quote.quotedGrossValue.toString(10),
        minimumGrossValue: quote.minimumGrossValue.toString(10),
        minValueOut: quote.minValueOut.toString(10),
        quotedProtocolFee: quote.quotedProtocolFee.toString(10),
        quotedCreatorFee: quote.quotedCreatorFee.toString(10),
      };
}

function quoteHashEqual(left: DepositQuote | WithdrawalQuote, right: DepositQuote | WithdrawalQuote): boolean {
  return left.kind === right.kind && left.quoteHash.equals(right.quoteHash);
}

export interface QuoteContext {
  readonly basket: PublicKey;
  readonly user: PublicKey;
  readonly compositionVersion: number;
  readonly navReportHash: Buffer;
  readonly basketNavValue: bigint;
  readonly sharePrice: bigint;
  readonly maximumSlippageBps: number;
  readonly protocolFeeDestination: PublicKey;
  readonly settlementMint: PublicKey;
  readonly performanceFeeBps: number;
  readonly sharesOwned: bigint;
  readonly costBasisValue: bigint;
  readonly weightedDepositTimestamp: bigint;
}

export interface QuoteContextPort {
  loadLatest(basket: PublicKey, user: PublicKey): Promise<QuoteContext>;
  loadForReport(
    basket: PublicKey,
    user: PublicKey,
    navReportHash: Uint8Array,
  ): Promise<QuoteContext>;
}

export interface ExecutionWalletRoute {
  readonly walletId: string;
  readonly polygonAddress: string;
}

export interface ExecutionWalletRoutePort {
  allocate(basketId: string): Promise<ExecutionWalletRoute>;
}

export interface DepositFundingRoutePort {
  createDepositFundingAddress(polymarketWallet: string): Promise<string>;
}

export interface PersistedApiOperation {
  readonly id: string;
  readonly kind: ExecutionKind;
  readonly state: ExecutionState;
  readonly workflowId: string;
  readonly workState:
    | "awaiting_funding"
    | "pending"
    | "claimed"
    | "dispatched"
    | "completed";
  readonly basket: string;
  readonly userAddress: string | null;
  readonly walletId: string;
  readonly fundingAddress: string | null;
  readonly fundingTransactionSignature: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FinancialRequestStorePort {
  createIntent(request: {
    readonly operationId: string;
    readonly requestKey: string;
    readonly requestHash: string;
    readonly workflowId: string;
    readonly wallet: ExecutionWalletRoute;
    readonly quote: DepositQuote | WithdrawalQuote;
    readonly intent: SignedDepositIntent | SignedWithdrawalIntent;
    readonly now: Date;
  }): Promise<PersistedApiOperation>;
  setDepositFundingAddress(
    operationId: string,
    address: string,
    now: Date,
  ): Promise<PersistedApiOperation>;
  submitDepositFunding(
    operationId: string,
    transactionSignature: string,
    idempotencyKey: string,
    now: Date,
  ): Promise<PersistedApiOperation>;
  loadOperation(operationId: string): Promise<PersistedApiOperation | null>;
  initializeBasketPortfolio(request: {
    readonly basketId: string;
    readonly compositionHash: string;
    readonly items: readonly Readonly<{
      readonly marketId: string;
      readonly conditionId: string;
      readonly tokenId: string;
      readonly outcome: string;
      readonly initialMarkPriceUnits: bigint;
      readonly markObservedAtMs: bigint;
      readonly markSourceHash: string;
    }>[];
    readonly now: Date;
  }): Promise<void>;
}

function operationJson(operation: PersistedApiOperation): ApiJsonObject {
  return {
    operationId: operation.id,
    kind: operation.kind,
    state: operation.state,
    workState: operation.workState,
    workflowId: operation.workflowId,
    basket: operation.basket,
    user: operation.userAddress,
    walletId: operation.walletId,
    fundingAddress: operation.fundingAddress,
    fundingTransactionSignature: operation.fundingTransactionSignature,
    lastError: operation.lastError,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
  };
}

export class AlphaBasketApiService implements FinancialApiPort {
  private readonly quotes = new QuoteService();
  private readonly intents = new IntentSubmissionService();

  public constructor(
    private readonly contexts: QuoteContextPort,
    private readonly requests: FinancialRequestStorePort,
    private readonly walletRoutes: ExecutionWalletRoutePort,
    private readonly fundingRoutes: DepositFundingRoutePort,
    private readonly basketCreation: BasketCreationOrchestrator,
  ) {}

  public async createDepositQuote(input: unknown): Promise<ApiJsonObject> {
    const request = parse(createDepositQuoteSchema, input);
    const context = await this.contexts.loadLatest(request.basket, request.user);
    this.assertSlippage(request.maxSlippageBps, context);
    return quoteJson(this.quotes.createDepositQuote({
      basket: request.basket,
      user: request.user,
      compositionVersion: context.compositionVersion,
      navReportHash: context.navReportHash,
      basketNavValue: context.basketNavValue,
      sharePrice: context.sharePrice,
      grossAmount: request.grossAmount,
      maxSlippageBps: request.maxSlippageBps,
      nowSeconds: nowSeconds(),
      expiresAtSeconds: request.expiresAtSeconds,
    }));
  }

  public async createWithdrawalQuote(input: unknown): Promise<ApiJsonObject> {
    const request = parse(createWithdrawalQuoteSchema, input);
    const context = await this.contexts.loadLatest(request.basket, request.user);
    this.assertSlippage(request.maxSlippageBps, context);
    if (request.shareAmount > context.sharesOwned) {
      throw new ApiRequestError(422, "insufficient_shares", "requested withdrawal exceeds the indexed position shares");
    }
    return quoteJson(this.quotes.createWithdrawalQuote({
      basket: request.basket,
      user: request.user,
      compositionVersion: context.compositionVersion,
      navReportHash: context.navReportHash,
      basketNavValue: context.basketNavValue,
      sharePrice: context.sharePrice,
      shareAmount: request.shareAmount,
      sharesOwned: context.sharesOwned,
      costBasisValue: context.costBasisValue,
      weightedDepositTimestamp: context.weightedDepositTimestamp,
      performanceFeeBps: context.performanceFeeBps,
      maxSlippageBps: request.maxSlippageBps,
      nowSeconds: nowSeconds(),
      expiresAtSeconds: request.expiresAtSeconds,
    }));
  }

  public async submitDepositIntent(input: unknown, idempotencyKey: string): Promise<ApiJsonObject> {
    validateIdempotencyKey(idempotencyKey);
    const request = parse(submitDepositIntentSchema, input);
    const authoritative = await this.recreateDepositQuote(request.quote);
    if (!quoteHashEqual(request.quote, authoritative)) {
      throw new ApiRequestError(409, "quote_mismatch", "deposit quote no longer matches authoritative basket state");
    }
    const intent = this.intents.submitDeposit({
      quote: authoritative,
      nonce: request.nonce,
      signature: decodeSignature(request.signature),
      nowSeconds: nowSeconds(),
    });
    const basketId = authoritative.basket.toBase58();
    const wallet = await this.walletRoutes.allocate(basketId);
    const operationId = randomUUID();
    const workflowId = deterministicWorkflowId("deposit", idempotencyKey);
    let operation = await this.requests.createIntent({
      operationId,
      requestKey: idempotencyKey,
      requestHash: executionRequestHash({
        kind: "deposit",
        basket: basketId,
        user: authoritative.user.toBase58(),
        intentHash: intent.intentHash.toString("hex"),
        grossAmount: authoritative.grossAmount,
      }),
      workflowId,
      wallet,
      quote: authoritative,
      intent,
      now: new Date(),
    });
    if (operation.fundingAddress === null) {
      const address = await this.fundingRoutes.createDepositFundingAddress(wallet.polygonAddress);
      operation = await this.requests.setDepositFundingAddress(operation.id, address, new Date());
    }
    const context = await this.contexts.loadForReport(
      authoritative.basket,
      authoritative.user,
      authoritative.navReportHash,
    );
    return {
      ...operationJson(operation),
      funding: {
        transactionMustBeSignedBy: authoritative.user.toBase58(),
        settlementMint: context.settlementMint.toBase58(),
        netAmount: authoritative.quotedNetValue.toString(10),
        netDestination: operation.fundingAddress,
        protocolFeeAmount: authoritative.protocolFee.toString(10),
        protocolFeeDestination: context.protocolFeeDestination.toBase58(),
      },
    };
  }

  public async submitWithdrawalIntent(input: unknown, idempotencyKey: string): Promise<ApiJsonObject> {
    validateIdempotencyKey(idempotencyKey);
    const request = parse(submitWithdrawalIntentSchema, input);
    const authoritative = await this.recreateWithdrawalQuote(request.quote);
    if (!quoteHashEqual(request.quote, authoritative)) {
      throw new ApiRequestError(409, "quote_mismatch", "withdrawal quote no longer matches authoritative basket state");
    }
    const intent = this.intents.submitWithdrawal({
      quote: authoritative,
      nonce: request.nonce,
      destination: request.destination,
      signature: decodeSignature(request.signature),
      nowSeconds: nowSeconds(),
    });
    const basketId = authoritative.basket.toBase58();
    const wallet = await this.walletRoutes.allocate(basketId);
    const operation = await this.requests.createIntent({
      operationId: randomUUID(),
      requestKey: idempotencyKey,
      requestHash: executionRequestHash({
        kind: "withdrawal",
        basket: basketId,
        user: authoritative.user.toBase58(),
        intentHash: intent.intentHash.toString("hex"),
        shareAmount: authoritative.shareAmount,
      }),
      workflowId: deterministicWorkflowId("withdrawal", idempotencyKey),
      wallet,
      quote: authoritative,
      intent,
      now: new Date(),
    });
    return operationJson(operation);
  }

  public async submitDepositFunding(
    operationId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<ApiJsonObject> {
    validateIdempotencyKey(idempotencyKey);
    if (!operationIdSchema.safeParse(operationId).success) {
      throw new ApiRequestError(400, "invalid_operation_id", "operation ID is invalid");
    }
    const request = parse(submitFundingSchema, input);
    const operation = await this.requests.submitDepositFunding(
      operationId,
      request.transactionSignature,
      idempotencyKey,
      new Date(),
    );
    return operationJson(operation);
  }

  public async getOperation(operationId: string): Promise<ApiJsonObject> {
    if (!operationIdSchema.safeParse(operationId).success) {
      throw new ApiRequestError(400, "invalid_operation_id", "operation ID is invalid");
    }
    const operation = await this.requests.loadOperation(operationId);
    if (operation === null) {
      throw new ApiRequestError(404, "operation_not_found", "execution operation was not found");
    }
    return operationJson(operation);
  }

  public async createBasket(input: unknown): Promise<ApiJsonObject> {
    const request = parse(createBasketSchema, input);
    const result = await this.basketCreation.composeSignAndCreate({
      basketId: Buffer.from(request.basketId, "hex"),
      creator: request.creator,
      creatorFeeDestination: request.creatorFeeDestination,
      isPerpetual: request.isPerpetual,
      reconstitutionCadenceSecs: request.reconstitutionCadenceSecs,
      compositionNonce: request.compositionNonce,
      compositionExpiry: request.compositionExpiry,
      ...(request.performanceFeeBps === undefined ? {} : { performanceFeeBps: request.performanceFeeBps }),
      candidates: request.candidates as readonly ComposerCandidate[],
      policy: request.policy as ComposerPolicy,
    });
    await this.requests.initializeBasketPortfolio({
      basketId: result.basketAddress,
      compositionHash: result.compositionHash,
      items: result.portfolioItems,
      now: new Date(),
    });
    return {
      basketAddress: result.basketAddress,
      transactionSignature: result.transactionSignature,
    };
  }

  private async recreateDepositQuote(quote: DepositQuote): Promise<DepositQuote> {
    const context = await this.contexts.loadForReport(quote.basket, quote.user, quote.navReportHash);
    this.assertSlippage(quote.maxSlippageBps, context);
    return this.quotes.createDepositQuote({
      basket: quote.basket,
      user: quote.user,
      compositionVersion: context.compositionVersion,
      navReportHash: context.navReportHash,
      basketNavValue: context.basketNavValue,
      sharePrice: context.sharePrice,
      grossAmount: quote.grossAmount,
      maxSlippageBps: quote.maxSlippageBps,
      nowSeconds: nowSeconds(),
      expiresAtSeconds: quote.expiresAtSeconds,
    });
  }

  private async recreateWithdrawalQuote(quote: WithdrawalQuote): Promise<WithdrawalQuote> {
    const context = await this.contexts.loadForReport(quote.basket, quote.user, quote.navReportHash);
    this.assertSlippage(quote.maxSlippageBps, context);
    if (quote.shareAmount > context.sharesOwned) {
      throw new ApiRequestError(422, "insufficient_shares", "requested withdrawal exceeds the indexed position shares");
    }
    return this.quotes.createWithdrawalQuote({
      basket: quote.basket,
      user: quote.user,
      compositionVersion: context.compositionVersion,
      navReportHash: context.navReportHash,
      basketNavValue: context.basketNavValue,
      sharePrice: context.sharePrice,
      shareAmount: quote.shareAmount,
      sharesOwned: context.sharesOwned,
      costBasisValue: context.costBasisValue,
      weightedDepositTimestamp: context.weightedDepositTimestamp,
      performanceFeeBps: context.performanceFeeBps,
      maxSlippageBps: quote.maxSlippageBps,
      nowSeconds: nowSeconds(),
      expiresAtSeconds: quote.expiresAtSeconds,
    });
  }

  private assertSlippage(requested: number, context: QuoteContext): void {
    if (requested > context.maximumSlippageBps) {
      throw new ApiRequestError(
        422,
        "slippage_above_protocol_limit",
        "requested slippage exceeds the on-chain protocol maximum",
      );
    }
  }
}

export const serializeFinancialQuote = quoteJson;

export function deserializeDepositQuote(value: unknown): DepositQuote {
  return parse(depositQuoteSchema, value);
}

export function deserializeWithdrawalQuote(value: unknown): WithdrawalQuote {
  return parse(withdrawalQuoteSchema, value);
}
