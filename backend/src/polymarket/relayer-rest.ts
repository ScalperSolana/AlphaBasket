import { createHash } from "node:crypto";

import { z } from "zod";

import { JsonHttpClient } from "./http-json.js";

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
const hexData = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/u);
const integerText = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const signatureParamsSchema = z.object({
  gasPrice: integerText,
  operation: integerText,
  safeTxnGas: integerText,
  baseGas: integerText,
  gasToken: hexAddress,
  refundReceiver: hexAddress,
}).strict();
const submissionSchema = z.object({
  from: hexAddress,
  to: hexAddress,
  proxyWallet: hexAddress,
  data: hexData,
  nonce: integerText,
  signature: hexData,
  signatureParams: signatureParamsSchema,
  type: z.enum(["SAFE", "PROXY"]),
}).strict();
const signedEnvelopeSchema = z.object({
  requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  submission: submissionSchema,
  authenticationHeaders: z.record(z.string().min(1).max(4_096)),
}).strict();
const submitResponseSchema = z.object({
  transactionID: z.string().min(1).max(256),
  state: z.enum(["STATE_NEW", "STATE_EXECUTED", "STATE_MINED", "STATE_CONFIRMED", "STATE_INVALID", "STATE_FAILED"]),
}).passthrough();
const transactionSchema = z.object({
  transactionID: z.string().min(1).max(256),
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/u).optional().or(z.literal("")),
  from: hexAddress,
  to: hexAddress,
  proxyAddress: hexAddress,
  data: hexData,
  nonce: integerText,
  state: z.enum(["STATE_NEW", "STATE_EXECUTED", "STATE_MINED", "STATE_CONFIRMED", "STATE_INVALID", "STATE_FAILED"]),
  type: z.enum(["SAFE", "PROXY"]),
}).passthrough();
const transactionResponseSchema = z.union([transactionSchema, z.array(transactionSchema).min(1).max(100)]);

export interface PolymarketRelayerTransaction {
  readonly to: string;
  readonly data: string;
  readonly value: "0";
}

export interface PolymarketRelayerEnvelopeSignerPort {
  /** Must replay the same nonce and signature for the same operationId/request hash. */
  prepare(request: {
    readonly operationId: string;
    readonly proxyWallet: string;
    readonly transactions: readonly PolymarketRelayerTransaction[];
    readonly description: string;
  }): Promise<z.infer<typeof signedEnvelopeSchema>>;
}

export interface RelayerDelayPort {
  sleep(durationMs: number): Promise<void>;
}

export interface PolymarketRelayerResult {
  readonly transactionId: string;
  readonly transactionHash: string;
  readonly state: "STATE_CONFIRMED";
}

export interface PolymarketRelayerPort {
  execute(request: {
    readonly operationId: string;
    readonly proxyWallet: string;
    readonly transactions: readonly PolymarketRelayerTransaction[];
    readonly description: string;
  }): Promise<PolymarketRelayerResult>;
}

const SYSTEM_RELAYER_DELAY: RelayerDelayPort = Object.freeze({
  sleep: async (durationMs: number) => new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, durationMs);
    timeout.unref();
  }),
});

function requestHash(request: {
  readonly operationId: string;
  readonly proxyWallet: string;
  readonly transactions: readonly PolymarketRelayerTransaction[];
  readonly description: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "ALPHABASKET_POLYMARKET_RELAYER_V1",
    request.operationId,
    request.proxyWallet.toLowerCase(),
    request.description,
    request.transactions.map((transaction) => [transaction.to.toLowerCase(), transaction.data.toLowerCase(), transaction.value]),
  ]), "utf8").digest("hex");
}

export class HttpPolymarketRelayerEnvelopeSigner implements PolymarketRelayerEnvelopeSignerPort {
  private readonly baseUrl: string;

  public constructor(
    private readonly http: JsonHttpClient,
    private readonly bearerToken: string,
    options: { readonly baseUrl: string; readonly allowInsecureLocalhost?: boolean },
  ) {
    const parsed = new URL(options.baseUrl);
    const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(options.allowInsecureLocalhost === true && local)) {
      throw new TypeError("relayer signer URL must use HTTPS outside localhost development");
    }
    if (bearerToken.length < 32 || bearerToken.length > 4_096) throw new RangeError("relayer signer token must contain 32-4096 characters");
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
  }

  public async prepare(request: {
    readonly operationId: string;
    readonly proxyWallet: string;
    readonly transactions: readonly PolymarketRelayerTransaction[];
    readonly description: string;
  }): Promise<z.infer<typeof signedEnvelopeSchema>> {
    const hash = requestHash(request);
    const response = await this.http.post(`${this.baseUrl}/v1/polymarket/relayer-envelope`, {
      ...request,
      requestHash: hash,
    }, signedEnvelopeSchema, { authorization: `Bearer ${this.bearerToken}` });
    if (response.requestHash !== hash) throw new Error("relayer signer returned an envelope for a different request");
    if (response.submission.proxyWallet.toLowerCase() !== request.proxyWallet.toLowerCase()) {
      throw new Error("relayer signer returned a different proxy wallet");
    }
    return response;
  }
}

export class PolymarketRelayerRest implements PolymarketRelayerPort {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly maximumPolls: number;

  public constructor(
    private readonly http: JsonHttpClient,
    private readonly signer: PolymarketRelayerEnvelopeSignerPort,
    private readonly delay: RelayerDelayPort = SYSTEM_RELAYER_DELAY,
    options: {
      readonly baseUrl?: string;
      readonly pollIntervalMs?: number;
      readonly maximumPolls?: number;
    } = {},
  ) {
    this.baseUrl = (options.baseUrl ?? "https://relayer-v2.polymarket.com").replace(/\/$/u, "");
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.maximumPolls = options.maximumPolls ?? 90;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 250 || this.pollIntervalMs > 30_000) throw new RangeError("invalid relayer poll interval");
    if (!Number.isSafeInteger(this.maximumPolls) || this.maximumPolls < 1 || this.maximumPolls > 1_000) throw new RangeError("invalid maximum relayer polls");
  }

  public async execute(request: {
    readonly operationId: string;
    readonly proxyWallet: string;
    readonly transactions: readonly PolymarketRelayerTransaction[];
    readonly description: string;
  }): Promise<PolymarketRelayerResult> {
    if (request.transactions.length === 0 || request.transactions.length > 64) throw new RangeError("relayer execution requires 1-64 transactions");
    const envelope = await this.signer.prepare(request);
    const submitted = await this.http.post(
      `${this.baseUrl}/submit`,
      envelope.submission,
      submitResponseSchema,
      envelope.authenticationHeaders,
    );
    if (submitted.state === "STATE_FAILED" || submitted.state === "STATE_INVALID") {
      throw new Error(`Polymarket relayer rejected transaction ${submitted.transactionID}`);
    }
    for (let attempt = 0; attempt < this.maximumPolls; attempt += 1) {
      const query = new URLSearchParams({ id: submitted.transactionID });
      const response = await this.http.get(
        `${this.baseUrl}/transaction?${query.toString()}`,
        transactionResponseSchema,
        envelope.authenticationHeaders,
      );
      const rows = Array.isArray(response) ? response : [response];
      const transaction = rows.find((row) => row.transactionID === submitted.transactionID);
      if (transaction === undefined) throw new Error("Polymarket relayer returned a different transaction ID");
      if (
        transaction.proxyAddress.toLowerCase() !== envelope.submission.proxyWallet.toLowerCase() ||
        transaction.from.toLowerCase() !== envelope.submission.from.toLowerCase() ||
        transaction.to.toLowerCase() !== envelope.submission.to.toLowerCase() ||
        transaction.data.toLowerCase() !== envelope.submission.data.toLowerCase() ||
        transaction.nonce !== envelope.submission.nonce ||
        transaction.type !== envelope.submission.type
      ) {
        throw new Error("Polymarket relayer transaction does not match the signed envelope");
      }
      if (transaction.state === "STATE_FAILED" || transaction.state === "STATE_INVALID") {
        throw new Error(`Polymarket relayer transaction ${transaction.transactionID} failed with ${transaction.state}`);
      }
      if (transaction.state === "STATE_CONFIRMED") {
        if (transaction.transactionHash === undefined || transaction.transactionHash.length === 0) throw new Error("confirmed relayer transaction is missing its Polygon hash");
        return Object.freeze({
          transactionId: transaction.transactionID,
          transactionHash: transaction.transactionHash.toLowerCase(),
          state: "STATE_CONFIRMED",
        });
      }
      await this.delay.sleep(this.pollIntervalMs);
    }
    throw new Error(`Polymarket relayer transaction ${submitted.transactionID} did not confirm within the polling window`);
  }
}
