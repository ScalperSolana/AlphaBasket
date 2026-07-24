import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  PolymarketPusdTransferPort,
  SolanaAtomicSplitPort,
} from "../execution/index.js";
import type {
  ClobOrderSignerPort,
  SignedClobOrderEnvelope,
} from "./fak-rest.js";
import { JsonHttpClient } from "./http-json.js";

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
const hexHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/u);
const lowerHash = z.string().regex(/^[0-9a-f]{64}$/u);
const integerText = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const canonicalBase64 = z.string().min(4).max(16_384);
const orderEnvelopeSchema = z.object({
  requestHash: lowerHash,
  serializedBodyBase64: canonicalBase64,
  authenticationHeaders: z.record(z.string().min(1).max(4_096)),
}).strict();
const transferResponseSchema = z.object({
  requestHash: lowerHash,
  transactionHash: hexHash,
}).strict();
const splitResponseSchema = z.object({
  requestHash: lowerHash,
  transactionSignature: z.string().min(64).max(128),
  finalizedSlot: integerText,
}).strict();

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export interface RemoteExecutionGatewayOptions {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly deploymentMode: "local" | "hybrid_devnet" | "production_canary" | "production";
  readonly allowInsecureLocalhost?: boolean;
}

class RemoteExecutionGatewayClient {
  protected readonly baseUrl: string;
  protected readonly authorization: Readonly<Record<string, string>>;

  public constructor(
    protected readonly http: JsonHttpClient,
    protected readonly options: RemoteExecutionGatewayOptions,
  ) {
    const parsed = new URL(options.baseUrl);
    const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(options.allowInsecureLocalhost === true && local)) {
      throw new TypeError("execution gateway URL must use HTTPS outside localhost development");
    }
    if (options.bearerToken.length < 32 || options.bearerToken.length > 4_096) {
      throw new RangeError("execution gateway token must contain 32-4096 characters");
    }
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.authorization = Object.freeze({
      authorization: `Bearer ${options.bearerToken}`,
      "x-alphabasket-request-version": "1",
    });
  }
}

export class HttpClobOrderSigner
  extends RemoteExecutionGatewayClient
  implements ClobOrderSignerPort
{
  public async signFakOrder(request: {
    readonly clientOrderId: string;
    readonly tokenId: string;
    readonly side: "BUY" | "SELL";
    readonly negativeRisk: boolean;
    readonly makerAmountUnits: bigint;
    readonly takerAmountUnits: bigint;
  }): Promise<SignedClobOrderEnvelope> {
    const payload = [
      "ALPHABASKET_REMOTE_FAK_ORDER_V1",
      this.options.deploymentMode,
      request.clientOrderId,
      request.tokenId,
      request.side,
      request.negativeRisk ? "1" : "0",
      request.makerAmountUnits.toString(10),
      request.takerAmountUnits.toString(10),
    ];
    const requestHash = hash(payload);
    const result = await this.http.post(
      `${this.baseUrl}/v1/polymarket/fak-order`,
      {
        requestHash,
        deploymentMode: this.options.deploymentMode,
        clientOrderId: request.clientOrderId,
        tokenId: request.tokenId,
        side: request.side,
        negativeRisk: request.negativeRisk,
        makerAmountUnits: request.makerAmountUnits.toString(10),
        takerAmountUnits: request.takerAmountUnits.toString(10),
      },
      orderEnvelopeSchema,
      this.authorization,
    );
    if (result.requestHash !== requestHash) throw new Error("execution gateway signed a different FAK request");
    const serializedBody = Buffer.from(result.serializedBodyBase64, "base64").toString("utf8");
    if (Buffer.from(serializedBody, "utf8").toString("base64") !== result.serializedBodyBase64) {
      throw new Error("execution gateway returned a non-canonical FAK body");
    }
    return Object.freeze({
      serializedBody,
      authenticationHeaders: Object.freeze({ ...result.authenticationHeaders }),
    });
  }
}

export class HttpPolymarketPusdTransfer
  extends RemoteExecutionGatewayClient
  implements PolymarketPusdTransferPort
{
  public async transferPusd(request: {
    readonly idempotencyKey: string;
    readonly destinationEvmAddress: string;
    readonly amountUnits: bigint;
  }): Promise<{ readonly transactionHash: string }> {
    if (request.amountUnits <= 0n || !hexAddress.safeParse(request.destinationEvmAddress).success) {
      throw new TypeError("invalid pUSD transfer request");
    }
    const requestHash = hash([
      "ALPHABASKET_REMOTE_PUSD_TRANSFER_V1",
      this.options.deploymentMode,
      request.idempotencyKey,
      request.destinationEvmAddress.toLowerCase(),
      request.amountUnits.toString(10),
    ]);
    const result = await this.http.post(
      `${this.baseUrl}/v1/polymarket/pusd-transfer`,
      {
        requestHash,
        deploymentMode: this.options.deploymentMode,
        idempotencyKey: request.idempotencyKey,
        destinationEvmAddress: request.destinationEvmAddress.toLowerCase(),
        amountUnits: request.amountUnits.toString(10),
      },
      transferResponseSchema,
      this.authorization,
    );
    if (result.requestHash !== requestHash) throw new Error("execution gateway transferred a different pUSD request");
    return Object.freeze({ transactionHash: result.transactionHash.toLowerCase() });
  }
}

export class HttpSolanaAtomicSplit
  extends RemoteExecutionGatewayClient
  implements SolanaAtomicSplitPort
{
  public async distribute(request: {
    readonly idempotencyKey: string;
    readonly sourceBridgeTransaction: string;
    readonly mint: string;
    readonly userDestination: string;
    readonly creatorDestination: string;
    readonly protocolDestination: string;
    readonly userAmountUnits: bigint;
    readonly creatorAmountUnits: bigint;
    readonly protocolAmountUnits: bigint;
  }): Promise<{ readonly transactionSignature: string; readonly finalizedSlot: bigint }> {
    const amounts = [
      request.userAmountUnits,
      request.creatorAmountUnits,
      request.protocolAmountUnits,
    ];
    if (amounts.some((amount) => amount < 0n) || amounts.every((amount) => amount === 0n)) {
      throw new RangeError("atomic split must distribute a positive non-negative amount");
    }
    const requestHash = hash([
      "ALPHABASKET_REMOTE_SOLANA_SPLIT_V1",
      this.options.deploymentMode,
      request.idempotencyKey,
      request.sourceBridgeTransaction,
      request.mint,
      request.userDestination,
      request.creatorDestination,
      request.protocolDestination,
      ...amounts.map((amount) => amount.toString(10)),
    ]);
    const result = await this.http.post(
      `${this.baseUrl}/v1/solana/atomic-split`,
      {
        requestHash,
        deploymentMode: this.options.deploymentMode,
        ...request,
        userAmountUnits: request.userAmountUnits.toString(10),
        creatorAmountUnits: request.creatorAmountUnits.toString(10),
        protocolAmountUnits: request.protocolAmountUnits.toString(10),
      },
      splitResponseSchema,
      this.authorization,
    );
    if (result.requestHash !== requestHash) throw new Error("execution gateway submitted a different Solana split");
    return Object.freeze({
      transactionSignature: result.transactionSignature,
      finalizedSlot: BigInt(result.finalizedSlot),
    });
  }
}

export const remoteExecutionGatewaySchemas = Object.freeze({
  canonicalBase64,
});
