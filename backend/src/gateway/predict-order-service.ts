import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";

import {
  ComputeBudgetProgram,
  PublicKey,
  VersionedMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";

import type { PredictRestPort } from "../predict/types.js";
import type { PolicyEnforcedSigner } from "../signer/index.js";
import type {
  GatewayPredictOrderRequest,
  GatewayPredictOrderResult,
  GatewayRequestStorePort,
} from "./types.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const PRICE_SCALE = 1_000_000n;
const U64_MAX = (1n << 64n) - 1n;

const integerText = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);

/**
 * Defense-in-depth policy for a Predict-built transaction, run immediately
 * before the settlement KMS signs. Amount and price validation live in
 * JupiterPredictOrderGateway; this check pins the fee payer/sole signer to the
 * capital wallet and the top-level programs to the configured allowlist.
 */
export function solanaPredictOrderMessageValidator(options: {
  readonly sourceOwner: PublicKey;
  readonly allowedProgramIds: readonly PublicKey[];
  readonly maximumMessageBytes?: number;
}): (payload: Uint8Array) => void {
  if (options.allowedProgramIds.length === 0) {
    throw new RangeError("Predict signing requires at least one allowlisted program");
  }
  const maximumMessageBytes = options.maximumMessageBytes ?? 1_232;
  const allowed = new Set([
    ...options.allowedProgramIds.map((program) => program.toBase58()),
    ComputeBudgetProgram.programId.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(),
  ]);
  const predictPrograms = new Set(options.allowedProgramIds.map((program) => program.toBase58()));
  return (payload) => {
    if (payload.byteLength === 0 || payload.byteLength > maximumMessageBytes) {
      throw new Error("Predict transaction message size is outside policy");
    }
    const message = VersionedMessage.deserialize(Buffer.from(payload));
    if (message.version !== 0) {
      throw new Error("Predict capital signing requires a version-0 transaction");
    }
    if (!message.staticAccountKeys[0]?.equals(options.sourceOwner)) {
      throw new Error("Predict transaction fee payer is not the configured capital wallet");
    }
    const requiredSigners = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures);
    if (requiredSigners.length !== 1 || !requiredSigners[0]?.equals(options.sourceOwner)) {
      throw new Error("Predict transaction must require exactly the configured capital signer");
    }
    if (message.compiledInstructions.length === 0 || message.compiledInstructions.length > 32) {
      throw new Error("Predict transaction instruction count is outside policy");
    }
    let predictCalls = 0;
    for (const instruction of message.compiledInstructions) {
      const program = message.staticAccountKeys[instruction.programIdIndex];
      if (program === undefined || !allowed.has(program.toBase58())) {
        throw new Error("Predict transaction invokes an unapproved top-level program");
      }
      if (predictPrograms.has(program.toBase58())) predictCalls += 1;
    }
    if (predictCalls === 0) {
      throw new Error("Predict transaction never invokes an allowlisted Predict program");
    }
  };
}

function verifySignature(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): void {
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]),
    type: "spki",
    format: "der",
  });
  if (!verify(null, Buffer.from(message), key, Buffer.from(signature))) {
    throw new Error("remote signer returned an invalid Predict transaction signature");
  }
}

export function hashGatewayPredictOrder(
  request: Omit<GatewayPredictOrderRequest, "requestHash">,
): string {
  return createHash("sha256").update(JSON.stringify([
    "ALPHABASKET_REMOTE_PREDICT_ORDER_V1",
    request.deploymentMode,
    request.clientOrderId,
    request.tokenId,
    request.jupiterMarketId,
    request.isYes,
    request.side,
    request.amountUnits.toString(10),
    request.worstPriceUnits.toString(10),
  ]), "utf8").digest("hex");
}

export interface JupiterPredictOrderGatewayOptions {
  readonly deploymentMode: GatewayPredictOrderRequest["deploymentMode"];
  readonly taker: PublicKey;
  readonly usdcMint: PublicKey;
  readonly allowedProgramIds: readonly PublicKey[];
  readonly maximumOrderUnits: bigint;
  readonly minimumOrderUnits: bigint;
  /** Bounded wait for the venue to report the order filled. */
  readonly fillPollAttempts?: number;
  readonly fillPollDelayMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface PreparedOrderEnvelope {
  readonly orderPubkey: string;
  readonly positionPubkey: string | null;
  readonly contractsMicro: string | null;
  readonly signedTransaction: string;
}

const preparedSchema = z.object({
  orderPubkey: z.string().min(32).max(64),
  positionPubkey: z.string().min(32).max(64).nullable(),
  contractsMicro: integerText.nullable(),
  signedTransaction: z.string().min(4).max(262_144),
}).strict();

/**
 * Key-holding boundary for Jupiter Predict orders.
 *
 * Mirrors the Jupiter swap gateway: the API-built transaction and its
 * signature are journaled before broadcast, so a replay resubmits the same
 * transaction instead of producing another economically distinct order. The
 * venue reports fills through its order account; the USDC leg is additionally
 * verified against the finalized transaction's token deltas, so a
 * misreporting API cannot move more cash than the on-chain truth.
 */
export class JupiterPredictOrderGateway {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fillPollAttempts: number;
  private readonly fillPollDelayMs: number;

  public constructor(
    private readonly store: GatewayRequestStorePort,
    private readonly signer: PolicyEnforcedSigner,
    private readonly rest: PredictRestPort,
    private readonly connection: Connection,
    private readonly options: JupiterPredictOrderGatewayOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fillPollAttempts = options.fillPollAttempts ?? 20;
    this.fillPollDelayMs = options.fillPollDelayMs ?? 1_500;
    if (options.allowedProgramIds.length === 0) {
      throw new RangeError("Predict gateway requires JUPITER_PREDICT_PROGRAM_IDS");
    }
    if (
      options.maximumOrderUnits <= 0n ||
      options.maximumOrderUnits > U64_MAX ||
      options.minimumOrderUnits <= 0n ||
      options.minimumOrderUnits > options.maximumOrderUnits
    ) {
      throw new RangeError("Predict gateway order limits are invalid");
    }
    if (
      !Number.isSafeInteger(this.fillPollAttempts) || this.fillPollAttempts < 1 ||
      !Number.isSafeInteger(this.fillPollDelayMs) || this.fillPollDelayMs < 1
    ) {
      throw new RangeError("Predict gateway fill polling bounds are invalid");
    }
  }

  public async executeOrder(
    request: GatewayPredictOrderRequest,
  ): Promise<GatewayPredictOrderResult> {
    this.validate(request);
    const hash = hashGatewayPredictOrder(request);
    if (hash !== request.requestHash) {
      throw new Error("Predict request hash does not match its canonical content");
    }
    const requestKey = `predict-order:${request.clientOrderId}`;
    const prepared = await this.store.prepare({
      requestKey,
      requestKind: "predict_order",
      requestHash: hash,
      build: async () => {
        const { transactionReference, ...journaled } = await this.buildSignedOrder(request);
        return {
          signedPayload: Uint8Array.from(Buffer.from(JSON.stringify(journaled), "utf8")),
          transactionReference,
        };
      },
      now: this.now(),
    });
    if (prepared.state === "finalized") {
      return this.mapFinalized(hash, request, prepared.result);
    }
    const envelope = preparedSchema.parse(
      JSON.parse(Buffer.from(prepared.signedPayload).toString("utf8")),
    ) as PreparedOrderEnvelope;
    const transactionSignature = prepared.transactionReference;
    if (transactionSignature === null) {
      throw new Error("journaled Predict order is missing its transaction signature");
    }

    // Broadcast (or re-observe on replay) and require finality.
    const statuses = await this.connection.getSignatureStatuses(
      [transactionSignature],
      { searchTransactionHistory: true },
    );
    let status = statuses.value[0] ?? null;
    if (status === null) {
      const submitted = await this.connection.sendRawTransaction(
        Buffer.from(envelope.signedTransaction, "base64"),
        { skipPreflight: false, maxRetries: 3 },
      );
      if (submitted !== transactionSignature) {
        throw new Error("Solana RPC returned a signature different from the journaled Predict order");
      }
      await this.store.markSubmitted(requestKey, transactionSignature, this.now());
      const confirmation = await this.connection.confirmTransaction(transactionSignature, "finalized");
      if (confirmation.value.err !== null) throw new Error("Predict order transaction failed on Solana");
      status = {
        slot: confirmation.context.slot,
        confirmations: null,
        err: null,
        confirmationStatus: "finalized",
      };
    }
    if (status === null || status.err !== null || status.confirmationStatus !== "finalized") {
      throw new Error("Predict order transaction is not finalized successfully");
    }
    const finalizedSlot = BigInt(status.slot);

    // The venue must report the order filled; FAK semantics accept no resting
    // remainder. `created`/`partiallyfilled` past the poll budget is a failure
    // the operation retries idempotently against the same journaled order.
    let orderStatus = await this.rest.getOrderStatus(envelope.orderPubkey);
    for (
      let attempt = 1;
      orderStatus !== "filled" && orderStatus !== "failed" && attempt < this.fillPollAttempts;
      attempt += 1
    ) {
      await this.sleep(this.fillPollDelayMs);
      orderStatus = await this.rest.getOrderStatus(envelope.orderPubkey);
    }
    if (orderStatus !== "filled") {
      throw new Error(`Predict order ${envelope.orderPubkey} is ${orderStatus}, not filled`);
    }

    // On-chain USDC truth for the cash leg.
    const usdcDelta = await this.takerUsdcDelta(transactionSignature);
    let filledInputUnits: bigint;
    let filledOutputUnits: bigint;
    if (request.side === "buy") {
      const debit = -usdcDelta;
      if (debit <= 0n || debit > request.amountUnits) {
        throw new Error("finalized Predict buy USDC debit is outside the requested amount");
      }
      const contracts = envelope.contractsMicro === null ? null : BigInt(envelope.contractsMicro);
      if (contracts === null || contracts <= 0n) {
        throw new Error("Predict buy is missing the venue-quoted contract amount");
      }
      // Average price bound: debit / contracts <= worst buy price.
      if (debit * PRICE_SCALE > contracts * request.worstPriceUnits) {
        throw new Error("finalized Predict buy violates the worst-price policy");
      }
      filledInputUnits = debit;
      filledOutputUnits = contracts;
    } else {
      const credit = usdcDelta;
      if (credit <= 0n) throw new Error("finalized Predict sell produced no USDC credit");
      // Proceeds bound: credit >= contracts * worst sell price.
      if (credit * PRICE_SCALE < request.amountUnits * request.worstPriceUnits) {
        throw new Error("finalized Predict sell violates the worst-price policy");
      }
      filledInputUnits = request.amountUnits;
      filledOutputUnits = credit;
    }

    const result = Object.freeze({
      side: request.side,
      tokenId: request.tokenId,
      jupiterMarketId: request.jupiterMarketId,
      orderPubkey: envelope.orderPubkey,
      positionPubkey: envelope.positionPubkey,
      outputMint: request.side === "sell" ? this.options.usdcMint.toBase58() : null,
      requestedAmountUnits: request.amountUnits.toString(10),
      filledInputUnits: filledInputUnits.toString(10),
      filledOutputUnits: filledOutputUnits.toString(10),
      transactionSignature,
      finalizedSlot: finalizedSlot.toString(10),
      executedAtMs: BigInt(this.now().getTime()).toString(10),
    });
    await this.store.markFinalized(requestKey, transactionSignature, result, this.now());
    return this.mapFinalized(hash, request, result);
  }

  private validate(request: GatewayPredictOrderRequest): void {
    if (request.deploymentMode !== this.options.deploymentMode) {
      throw new Error("Predict deployment mode does not match the gateway");
    }
    if (!/^[A-Za-z0-9_.:-]{40,160}$/u.test(request.clientOrderId)) {
      throw new TypeError("Predict client order id is invalid");
    }
    if (!/^(?:0|[1-9][0-9]*)$/u.test(request.tokenId)) {
      throw new TypeError("Predict token id must be a decimal CTF token id");
    }
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(request.jupiterMarketId)) {
      throw new TypeError("Predict market id is invalid");
    }
    if (request.worstPriceUnits <= 0n || request.worstPriceUnits >= PRICE_SCALE) {
      throw new RangeError("Predict worst price must be inside (0, 1) dollars");
    }
    if (request.amountUnits <= 0n || request.amountUnits > U64_MAX) {
      throw new RangeError("Predict order amount must be a positive u64");
    }
    if (request.side === "buy") {
      if (
        request.amountUnits > this.options.maximumOrderUnits ||
        request.amountUnits < this.options.minimumOrderUnits
      ) {
        throw new RangeError("Predict buy amount is outside the gateway policy");
      }
    } else {
      // Sells are sized in contracts; the USDC leg is bounded by contracts * 1$.
      if (request.amountUnits > this.options.maximumOrderUnits * 100n) {
        throw new RangeError("Predict sell contract amount is outside the gateway policy");
      }
    }
  }

  private async buildSignedOrder(request: GatewayPredictOrderRequest): Promise<
    PreparedOrderEnvelope & { readonly transactionReference: string }
  > {
    // Pre-trade quote gate: refuse to sign when the venue's current quote is
    // already through the worst price the runner derived from the same feed.
    const market = await this.rest.getMarket(request.jupiterMarketId);
    if (market.status !== "open") {
      throw new Error(`Predict market ${request.jupiterMarketId} is ${market.status}, not open`);
    }
    const quoted = request.side === "buy"
      ? (request.isYes ? market.pricing.buyYesPriceUnits : market.pricing.buyNoPriceUnits)
      : (request.isYes ? market.pricing.sellYesPriceUnits : market.pricing.sellNoPriceUnits);
    if (quoted === null) {
      throw new Error(`Predict market ${request.jupiterMarketId} has no ${request.side} quote`);
    }
    if (request.side === "buy" ? quoted > request.worstPriceUnits : quoted < request.worstPriceUnits) {
      throw new Error("Predict quote is already outside the worst-price policy");
    }

    const build = await this.rest.buildOrder({
      ownerPubkey: this.options.taker.toBase58(),
      depositMint: this.options.usdcMint.toBase58(),
      amountUnits: request.amountUnits,
      marketId: request.jupiterMarketId,
      isYes: request.isYes,
      isBuy: request.side === "buy",
    });
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(build.transactionBase64, "base64"),
    );
    const message = transaction.message;
    const signerCount = message.header.numRequiredSignatures;
    if (
      signerCount !== 1 ||
      !message.staticAccountKeys[0]?.equals(this.options.taker)
    ) {
      throw new Error("Predict transaction must bind exactly the configured taker as fee payer and signer");
    }
    if (transaction.signatures[0]?.some((byte) => byte !== 0) === true) {
      throw new Error("Predict transaction unexpectedly contains a taker signature");
    }
    const serialized = message.serialize();
    // Same validator the KMS policy runs; failing here avoids a signer round trip.
    solanaPredictOrderMessageValidator({
      sourceOwner: this.options.taker,
      allowedProgramIds: this.options.allowedProgramIds,
    })(serialized);
    const signed = await this.signer.sign({
      role: "solana_settlement",
      payload: serialized,
      context: {
        domain: "alphabasket:solana-capital-transaction:v1",
        action: "execute_predict_order",
        network: "solana-mainnet-beta",
        expiresAt: new Date(this.now().getTime() + 60_000),
        intentHash: request.requestHash,
      },
    });
    if (!new PublicKey(signed.publicKey).equals(this.options.taker)) {
      throw new Error("Predict signer public key does not match the configured taker");
    }
    verifySignature(serialized, signed.signature, signed.publicKey);
    transaction.signatures[0] = Uint8Array.from(signed.signature);
    return Object.freeze({
      orderPubkey: build.orderPubkey,
      positionPubkey: build.positionPubkey,
      contractsMicro: build.contractsMicro?.toString(10) ?? null,
      signedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
      transactionReference: bs58.encode(signed.signature),
    });
  }

  /** Net six-decimal USDC delta of the taker's token accounts in the finalized transaction. */
  private async takerUsdcDelta(signature: string): Promise<bigint> {
    const transaction = await this.connection.getParsedTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (transaction === null || transaction.meta?.err !== null) {
      throw new Error("Predict order transaction is not finalized and successful");
    }
    const owner = this.options.taker.toBase58();
    const mint = this.options.usdcMint.toBase58();
    const total = (phase: "pre" | "post"): bigint => {
      const balances = phase === "pre"
        ? transaction.meta?.preTokenBalances
        : transaction.meta?.postTokenBalances;
      let sum = 0n;
      for (const balance of balances ?? []) {
        if (balance.owner === owner && balance.mint === mint) {
          sum += BigInt(balance.uiTokenAmount.amount);
        }
      }
      return sum;
    };
    return total("post") - total("pre");
  }

  private mapFinalized(
    requestHash: string,
    request: GatewayPredictOrderRequest,
    value: Readonly<Record<string, unknown>> | null,
  ): GatewayPredictOrderResult {
    const parsed = z.object({
      side: z.literal(request.side),
      tokenId: z.literal(request.tokenId),
      jupiterMarketId: z.literal(request.jupiterMarketId),
      orderPubkey: z.string().min(32).max(64),
      positionPubkey: z.string().min(32).max(64).nullable(),
      outputMint: z.string().nullable(),
      requestedAmountUnits: integerText,
      filledInputUnits: integerText,
      filledOutputUnits: integerText,
      transactionSignature: z.string().min(64).max(128),
      finalizedSlot: integerText,
      executedAtMs: integerText,
    }).strict().parse(value);
    return Object.freeze({
      requestHash,
      side: parsed.side,
      tokenId: parsed.tokenId,
      jupiterMarketId: parsed.jupiterMarketId,
      orderPubkey: parsed.orderPubkey,
      positionPubkey: parsed.positionPubkey,
      requestedAmountUnits: BigInt(parsed.requestedAmountUnits),
      filledInputUnits: BigInt(parsed.filledInputUnits),
      filledOutputUnits: BigInt(parsed.filledOutputUnits),
      transactionSignature: parsed.transactionSignature,
      finalizedSlot: BigInt(parsed.finalizedSlot),
      executedAtMs: BigInt(parsed.executedAtMs),
    });
  }
}
