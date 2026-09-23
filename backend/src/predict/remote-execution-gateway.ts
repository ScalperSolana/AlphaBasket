import { z } from "zod";

import type {
  FakExecutionPort,
  FakOrderRequest,
  FakOrderResult,
} from "../execution/types.js";
import {
  hashGatewayPredictOrder,
  type GatewayPredictOrderRequest,
} from "../gateway/index.js";
import { JsonHttpClient } from "../polymarket/index.js";
import type { PredictMarketResolverPort } from "./types.js";

const integerText = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const responseSchema = z.object({
  requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  side: z.enum(["buy", "sell"]),
  tokenId: integerText,
  jupiterMarketId: z.string().min(1).max(128),
  orderPubkey: z.string().min(32).max(64),
  positionPubkey: z.string().min(32).max(64).nullable(),
  outputMint: z.string().nullable().optional(),
  requestedAmountUnits: integerText,
  filledInputUnits: integerText,
  filledOutputUnits: integerText,
  transactionSignature: z.string().min(64).max(128),
  finalizedSlot: integerText,
  executedAtMs: integerText,
}).passthrough();

export interface RemotePredictExecutionOptions {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly deploymentMode: GatewayPredictOrderRequest["deploymentMode"];
  readonly allowInsecureLocalhost?: boolean;
}

/**
 * Worker-side prediction execution through the key-holding gateway, Jupiter
 * Predict venue. Implements the same FAK port the CLOB venue implements, so
 * the deposit/withdrawal workflows and the Postgres FAK journal are untouched:
 * a buy spends USDC and yields contracts, a sell spends contracts and yields
 * USDC, and the transaction hashes are Solana signatures.
 */
export class HttpJupiterPredictExecution implements FakExecutionPort {
  private readonly baseUrl: string;
  private readonly authorization: Readonly<Record<string, string>>;

  public constructor(
    private readonly http: JsonHttpClient,
    private readonly resolver: PredictMarketResolverPort,
    private readonly options: RemotePredictExecutionOptions,
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

  public async executeFak(request: FakOrderRequest): Promise<FakOrderResult> {
    if (request.clientOrderId.length === 0 || request.tokenId.length === 0) {
      throw new TypeError("Predict order identifiers must not be empty");
    }
    const resolution = await this.resolver.resolve({
      tokenId: request.tokenId,
      ...(request.marketId === undefined ? {} : { marketId: request.marketId }),
      ...(request.conditionId === undefined ? {} : { conditionId: request.conditionId }),
      ...(request.outcomeIndex === undefined ? {} : { outcomeIndex: request.outcomeIndex }),
    });
    const content = {
      deploymentMode: this.options.deploymentMode,
      clientOrderId: request.clientOrderId,
      tokenId: request.tokenId,
      jupiterMarketId: resolution.jupiterMarketId,
      isYes: resolution.isYes,
      side: request.side,
      amountUnits: request.amountUnits,
      worstPriceUnits: request.worstPriceUnits,
    } as const;
    const requestHash = hashGatewayPredictOrder(content);
    const result = await this.http.post(
      `${this.baseUrl}/v1/predict/order`,
      {
        ...content,
        requestHash,
        amountUnits: request.amountUnits.toString(10),
        worstPriceUnits: request.worstPriceUnits.toString(10),
      },
      responseSchema,
      this.authorization,
    );
    if (
      result.requestHash !== requestHash ||
      result.tokenId !== request.tokenId ||
      result.side !== request.side ||
      BigInt(result.requestedAmountUnits) !== request.amountUnits
    ) {
      throw new Error("execution gateway completed a different Predict request");
    }
    const filledInput = BigInt(result.filledInputUnits);
    const filledOutput = BigInt(result.filledOutputUnits);
    if (filledInput <= 0n || filledOutput <= 0n) {
      throw new Error("execution gateway returned an empty Predict fill");
    }
    const averagePrice = request.side === "buy"
      ? (filledInput * 1_000_000n) / filledOutput
      : (filledOutput * 1_000_000n) / filledInput;
    return Object.freeze({
      clientOrderId: request.clientOrderId,
      orderId: result.orderPubkey,
      tokenId: request.tokenId,
      side: request.side,
      requestedAmountUnits: request.amountUnits,
      filledInputUnits: filledInput,
      filledOutputUnits: filledOutput,
      averagePriceUnits: averagePrice,
      status: filledInput === request.amountUnits ? "matched" as const : "partially_filled" as const,
      transactionHashes: Object.freeze([result.transactionSignature]),
      tradeIds: Object.freeze(
        result.positionPubkey === null ? [result.orderPubkey] : [result.orderPubkey, result.positionPubkey],
      ),
      executedAtMs: BigInt(result.executedAtMs),
    });
  }
}
