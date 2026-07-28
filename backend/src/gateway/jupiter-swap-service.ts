import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";

import {
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { z } from "zod";

import { JsonHttpClient } from "../polymarket/index.js";
import type { PolicyEnforcedSigner } from "../signer/index.js";
import type {
  GatewayJupiterSwapRequest,
  GatewayJupiterSwapResult,
  GatewayRequestStorePort,
} from "./types.js";
import type { JupiterSwapFinalityPort } from "./jupiter-finality.js";
import { solanaJupiterSwapMessageValidator } from "./solana-message-policy.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const U64_MAX = (1n << 64n) - 1n;
const positiveInteger = z.union([
  z.string().regex(/^[1-9][0-9]*$/u),
  z.number().int().positive().safe().transform(String),
]);
const publicKeyString = z.string().refine((value) => {
  try {
    return !new PublicKey(value).equals(PublicKey.default);
  } catch {
    return false;
  }
});
const base64Transaction = z.string().max(262_144).refine((value) => {
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.byteLength > 0 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
});

const orderSchema = z.object({
  requestId: z.string().min(8).max(512),
  transaction: base64Transaction,
  inputMint: publicKeyString.optional(),
  outputMint: publicKeyString.optional(),
  inAmount: positiveInteger.optional(),
  outAmount: positiveInteger,
  otherAmountThreshold: positiveInteger.optional(),
  swapMode: z.literal("ExactIn").optional(),
}).passthrough();

const swapEventSchema = z.object({
  inputMint: publicKeyString.optional(),
  outputMint: publicKeyString.optional(),
  inputAmount: positiveInteger.optional(),
  outputAmount: positiveInteger.optional(),
}).passthrough();

const executeSchema = z.object({
  status: z.string().min(1).max(64),
  code: z.number().int().optional(),
  signature: z.string().min(64).max(128),
  slot: z.union([
    z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
    z.number().int().nonnegative().safe().transform(String),
  ]),
  inputAmountResult: positiveInteger,
  outputAmountResult: positiveInteger,
  swapEvents: z.array(swapEventSchema).max(128).optional(),
  error: z.string().max(4_096).nullable().optional(),
}).passthrough();

interface PreparedSwapEnvelope {
  readonly requestId: string;
  readonly signedTransaction: string;
  readonly quotedOutputUnits: string;
  readonly minimumOutputUnits: string;
}

function checkedMinimum(quotedOutput: bigint, slippageBps: number): bigint {
  const minimum = quotedOutput * BigInt(10_000 - slippageBps) / 10_000n;
  return minimum > 0n ? minimum : 1n;
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
    throw new Error("remote signer returned an invalid Jupiter transaction signature");
  }
}

export function hashGatewayJupiterSwap(
  request: Omit<GatewayJupiterSwapRequest, "requestHash">,
): string {
  return createHash("sha256").update(JSON.stringify([
    "ALPHABASKET_REMOTE_JUPITER_EXACT_IN_V1",
    request.deploymentMode,
    request.idempotencyKey,
    request.inputMint,
    request.outputMint,
    request.inputAmountUnits.toString(10),
    request.slippageBps,
    request.taker,
  ]), "utf8").digest("hex");
}

export interface JupiterSwapGatewayOptions {
  readonly deploymentMode: GatewayJupiterSwapRequest["deploymentMode"];
  readonly apiKey: string;
  readonly taker: PublicKey;
  readonly usdcMint: PublicKey;
  readonly aggregatorProgramId: PublicKey;
  readonly maximumInputUnits: bigint;
  readonly finality: JupiterSwapFinalityPort;
  readonly baseUrl?: string;
  readonly now?: () => Date;
}

/**
 * Key-holding boundary for Jupiter Swap V2.
 *
 * The exact API order and its signature are journaled before submission. A
 * replay therefore resubmits the same transaction/requestId pair instead of
 * producing another economically distinct swap.
 */
export class JupiterSwapGateway {
  private readonly now: () => Date;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  public constructor(
    private readonly store: GatewayRequestStorePort,
    private readonly signer: PolicyEnforcedSigner,
    private readonly http: JsonHttpClient,
    private readonly options: JupiterSwapGatewayOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.baseUrl = (options.baseUrl ?? "https://api.jup.ag/swap/v2").replace(/\/+$/u, "");
    this.apiKey = options.apiKey.trim();
    if (!this.baseUrl.startsWith("https://")) {
      throw new TypeError("Jupiter Swap API URL must use HTTPS");
    }
    if (this.apiKey.length === 0 || this.apiKey.length > 512) {
      throw new TypeError("Jupiter API key must contain 1-512 characters");
    }
    if (options.maximumInputUnits <= 0n || options.maximumInputUnits > U64_MAX) {
      throw new RangeError("Jupiter maximum input must be a positive u64");
    }
  }

  public async executeExactIn(
    request: GatewayJupiterSwapRequest,
  ): Promise<GatewayJupiterSwapResult> {
    this.validate(request);
    const hash = hashGatewayJupiterSwap(request);
    if (hash !== request.requestHash) {
      throw new Error("Jupiter request hash does not match its canonical content");
    }
    const requestKey = `jupiter-swap:${request.idempotencyKey}`;
    const prepared = await this.store.prepare({
      requestKey,
      requestKind: "jupiter_swap",
      requestHash: hash,
      build: async () => ({
        signedPayload: await this.buildSignedOrder(request),
      }),
      now: this.now(),
    });
    if (prepared.state === "finalized") {
      return this.mapFinalized(hash, request, prepared.result);
    }
    const envelope = this.parsePrepared(prepared.signedPayload);
    const raw = await this.http.post(
      `${this.baseUrl}/execute`,
      {
        signedTransaction: envelope.signedTransaction,
        requestId: envelope.requestId,
      },
      executeSchema,
      { "x-api-key": this.apiKey },
    );
    if (raw.status.toLowerCase() !== "success" || (raw.code !== undefined && raw.code !== 0)) {
      throw new Error(`Jupiter execution failed: ${raw.error ?? raw.status}`);
    }
    const filledInput = BigInt(raw.inputAmountResult);
    const filledOutput = BigInt(raw.outputAmountResult);
    const minimum = BigInt(envelope.minimumOutputUnits);
    if (
      filledInput <= 0n ||
      filledInput > request.inputAmountUnits ||
      filledOutput <= 0n ||
      filledOutput * request.inputAmountUnits < minimum * filledInput
    ) {
      throw new Error("Jupiter execution amounts violate the exact-in slippage policy");
    }
    this.validateSwapEvents(raw.swapEvents, request, filledInput, filledOutput);
    const finality = await this.options.finality.verifyFinalized({
      signature: raw.signature,
      taker: this.options.taker,
      inputMint: new PublicKey(request.inputMint),
      outputMint: new PublicKey(request.outputMint),
      requestedInputUnits: request.inputAmountUnits,
      reportedInputUnits: filledInput,
      reportedOutputUnits: filledOutput,
    });
    if (finality.finalizedSlot !== BigInt(raw.slot)) {
      throw new Error(
        "Jupiter API slot does not match the independently finalized transaction slot",
      );
    }
    if (
      filledOutput * request.inputAmountUnits <
      minimum * finality.inputDebitUnits
    ) {
      throw new Error(
        "finalized Jupiter token deltas violate the exact-in slippage policy",
      );
    }
    const result = Object.freeze({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      requestedInputUnits: request.inputAmountUnits.toString(10),
      filledInputUnits: finality.inputDebitUnits.toString(10),
      filledOutputUnits: filledOutput.toString(10),
      minimumOutputUnits: minimum.toString(10),
      transactionSignature: raw.signature,
      finalizedSlot: finality.finalizedSlot.toString(10),
      executedAtMs: BigInt(this.now().getTime()).toString(10),
      status: finality.inputDebitUnits === request.inputAmountUnits
        ? "filled"
        : "partially_filled",
    });
    await this.store.markSubmitted(requestKey, raw.signature, this.now());
    await this.store.markFinalized(requestKey, raw.signature, result, this.now());
    return this.mapFinalized(hash, request, result);
  }

  private validate(request: GatewayJupiterSwapRequest): void {
    if (request.deploymentMode !== this.options.deploymentMode) {
      throw new Error("Jupiter deployment mode does not match the gateway");
    }
    if (!/^[A-Za-z0-9_.:-]{8,128}$/u.test(request.idempotencyKey)) {
      throw new TypeError("Jupiter idempotency key is invalid");
    }
    const inputMint = new PublicKey(request.inputMint);
    const outputMint = new PublicKey(request.outputMint);
    const taker = new PublicKey(request.taker);
    if (
      inputMint.equals(PublicKey.default) ||
      outputMint.equals(PublicKey.default) ||
      inputMint.equals(outputMint)
    ) {
      throw new TypeError("Jupiter mints must be distinct non-zero public keys");
    }
    if (!taker.equals(this.options.taker)) {
      throw new Error("Jupiter taker is not the configured capital wallet");
    }
    if (
      !inputMint.equals(this.options.usdcMint) &&
      !outputMint.equals(this.options.usdcMint)
    ) {
      throw new Error("Jupiter swap must enter or exit through configured mainnet USDC");
    }
    if (
      request.inputAmountUnits <= 0n ||
      request.inputAmountUnits > this.options.maximumInputUnits ||
      request.inputAmountUnits > U64_MAX
    ) {
      throw new RangeError("Jupiter input exceeds the gateway amount policy");
    }
    if (
      !Number.isSafeInteger(request.slippageBps) ||
      request.slippageBps < 1 ||
      request.slippageBps > 2_000
    ) {
      throw new RangeError("Jupiter slippage must be between 1 and 2000 bps");
    }
  }

  private async buildSignedOrder(request: GatewayJupiterSwapRequest): Promise<Uint8Array> {
    const query = new URLSearchParams({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.inputAmountUnits.toString(10),
      taker: request.taker,
      swapMode: "ExactIn",
      slippageBps: request.slippageBps.toString(10),
      wrapAndUnwrapSol: "false",
    });
    const raw = await this.http.get(
      `${this.baseUrl}/order?${query.toString()}`,
      orderSchema,
      { "x-api-key": this.apiKey },
    );
    if (
      (raw.inputMint !== undefined && raw.inputMint !== request.inputMint) ||
      (raw.outputMint !== undefined && raw.outputMint !== request.outputMint) ||
      (raw.inAmount !== undefined && BigInt(raw.inAmount) !== request.inputAmountUnits)
    ) {
      throw new Error("Jupiter order response does not match the exact-in request");
    }
    const quotedOutput = BigInt(raw.outAmount);
    const computedMinimum = checkedMinimum(quotedOutput, request.slippageBps);
    const apiMinimum = raw.otherAmountThreshold === undefined
      ? computedMinimum
      : BigInt(raw.otherAmountThreshold);
    if (apiMinimum <= 0n || apiMinimum > quotedOutput || apiMinimum < computedMinimum) {
      throw new Error("Jupiter order minimum output weakens the requested slippage policy");
    }
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(raw.transaction, "base64"),
    );
    const signerCount = transaction.message.header.numRequiredSignatures;
    const signerKeys = transaction.message.staticAccountKeys.slice(0, signerCount);
    const signerIndex = signerKeys.findIndex((key) => key.equals(this.options.taker));
    if (
      signerCount !== 1 ||
      signerIndex !== 0 ||
      !transaction.message.staticAccountKeys[0]?.equals(this.options.taker)
    ) {
      throw new Error(
        "Jupiter transaction must bind exactly the configured taker as fee payer and signer",
      );
    }
    if (
      transaction.signatures[signerIndex] === undefined ||
      transaction.signatures[signerIndex]?.some((byte) => byte !== 0)
    ) {
      throw new Error("Jupiter transaction unexpectedly contains a taker signature");
    }
    const message = transaction.message.serialize();
    solanaJupiterSwapMessageValidator({
      sourceOwner: this.options.taker,
      aggregatorProgramId: this.options.aggregatorProgramId,
    })(message);
    const signed = await this.signer.sign({
      role: "solana_settlement",
      payload: message,
      context: {
        domain: "alphabasket:solana-capital-transaction:v1",
        action: "execute_jupiter_swap",
        network: "solana-mainnet-beta",
        expiresAt: new Date(this.now().getTime() + 60_000),
        intentHash: request.requestHash,
      },
    });
    if (!new PublicKey(signed.publicKey).equals(this.options.taker)) {
      throw new Error("Jupiter signer public key does not match the configured taker");
    }
    verifySignature(message, signed.signature, signed.publicKey);
    transaction.signatures[signerIndex] = Uint8Array.from(signed.signature);
    const envelope: PreparedSwapEnvelope = Object.freeze({
      requestId: raw.requestId,
      signedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
      quotedOutputUnits: quotedOutput.toString(10),
      minimumOutputUnits: apiMinimum.toString(10),
    });
    return Uint8Array.from(Buffer.from(JSON.stringify(envelope), "utf8"));
  }

  private parsePrepared(payload: Uint8Array): PreparedSwapEnvelope {
    const parsed = z.object({
      requestId: z.string().min(8).max(512),
      signedTransaction: base64Transaction,
      quotedOutputUnits: positiveInteger,
      minimumOutputUnits: positiveInteger,
    }).strict().parse(JSON.parse(Buffer.from(payload).toString("utf8")));
    return Object.freeze(parsed);
  }

  private validateSwapEvents(
    events: z.output<typeof swapEventSchema>[] | undefined,
    request: GatewayJupiterSwapRequest,
    filledInput: bigint,
    filledOutput: bigint,
  ): void {
    if (events === undefined || events.length === 0) return;
    const matching = events.filter((event) =>
      event.inputMint === request.inputMint &&
      event.outputMint === request.outputMint &&
      event.inputAmount !== undefined &&
      event.outputAmount !== undefined
    );
    const input = matching.reduce((sum, event) => sum + BigInt(event.inputAmount as string), 0n);
    const output = matching.reduce((sum, event) => sum + BigInt(event.outputAmount as string), 0n);
    if (input !== filledInput || output !== filledOutput) {
      throw new Error("Jupiter swap events do not reconcile with execution totals");
    }
  }

  private mapFinalized(
    requestHash: string,
    request: GatewayJupiterSwapRequest,
    value: Readonly<Record<string, unknown>> | null,
  ): GatewayJupiterSwapResult {
    const parsed = z.object({
      inputMint: z.literal(request.inputMint),
      outputMint: z.literal(request.outputMint),
      requestedInputUnits: positiveInteger,
      filledInputUnits: positiveInteger,
      filledOutputUnits: positiveInteger,
      minimumOutputUnits: positiveInteger,
      transactionSignature: z.string().min(64).max(128),
      finalizedSlot: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
      executedAtMs: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
      status: z.enum(["filled", "partially_filled"]),
    }).strict().parse(value);
    return Object.freeze({
      requestHash,
      inputMint: parsed.inputMint,
      outputMint: parsed.outputMint,
      requestedInputUnits: BigInt(parsed.requestedInputUnits),
      filledInputUnits: BigInt(parsed.filledInputUnits),
      filledOutputUnits: BigInt(parsed.filledOutputUnits),
      minimumOutputUnits: BigInt(parsed.minimumOutputUnits),
      transactionSignature: parsed.transactionSignature,
      finalizedSlot: BigInt(parsed.finalizedSlot),
      executedAtMs: BigInt(parsed.executedAtMs),
      status: parsed.status,
    });
  }
}
