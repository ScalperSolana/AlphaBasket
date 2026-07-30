import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import {
  hashGatewayJupiterSwap,
  type GatewayJupiterSwapRequest,
} from "../gateway/index.js";
import { JsonHttpClient } from "../polymarket/index.js";
import type {
  JupiterExactInRequest,
  JupiterExactInResult,
  JupiterExecutionPort,
} from "./types.js";

const responseSchema = z.object({
  requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  inputMint: z.string().min(32).max(64),
  outputMint: z.string().min(32).max(64),
  requestedInputUnits: z.string().regex(/^[1-9][0-9]*$/u),
  filledInputUnits: z.string().regex(/^[1-9][0-9]*$/u),
  filledOutputUnits: z.string().regex(/^[1-9][0-9]*$/u),
  minimumOutputUnits: z.string().regex(/^[1-9][0-9]*$/u),
  transactionSignature: z.string().min(64).max(128),
  finalizedSlot: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  executedAtMs: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  status: z.enum(["filled", "partially_filled"]),
}).strict();

export interface RemoteJupiterExecutionOptions {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly deploymentMode: GatewayJupiterSwapRequest["deploymentMode"];
  readonly allowInsecureLocalhost?: boolean;
}

export class HttpJupiterExecution implements JupiterExecutionPort {
  private readonly baseUrl: string;
  private readonly authorization: Readonly<Record<string, string>>;

  public constructor(
    private readonly http: JsonHttpClient,
    private readonly options: RemoteJupiterExecutionOptions,
  ) {
    const parsed = new URL(options.baseUrl);
    const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
    if (
      parsed.protocol !== "https:" &&
      !(options.allowInsecureLocalhost === true && local)
    ) {
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

  public async executeExactIn(
    request: JupiterExactInRequest,
  ): Promise<JupiterExactInResult> {
    const content = {
      deploymentMode: this.options.deploymentMode,
      idempotencyKey: request.idempotencyKey,
      inputMint: request.inputMint.toBase58(),
      outputMint: request.outputMint.toBase58(),
      inputAmountUnits: request.inputAmountUnits,
      slippageBps: request.slippageBps,
      taker: request.taker.toBase58(),
    } as const;
    const requestHash = hashGatewayJupiterSwap(content);
    const result = await this.http.post(
      `${this.baseUrl}/v1/jupiter/exact-in`,
      {
        ...content,
        requestHash,
        inputAmountUnits: request.inputAmountUnits.toString(10),
      },
      responseSchema,
      this.authorization,
    );
    if (
      result.requestHash !== requestHash ||
      result.inputMint !== content.inputMint ||
      result.outputMint !== content.outputMint ||
      BigInt(result.requestedInputUnits) !== request.inputAmountUnits
    ) {
      throw new Error("execution gateway completed a different Jupiter request");
    }
    return Object.freeze({
      idempotencyKey: request.idempotencyKey,
      inputMint: new PublicKey(result.inputMint),
      outputMint: new PublicKey(result.outputMint),
      requestedInputUnits: BigInt(result.requestedInputUnits),
      filledInputUnits: BigInt(result.filledInputUnits),
      filledOutputUnits: BigInt(result.filledOutputUnits),
      minimumOutputUnits: BigInt(result.minimumOutputUnits),
      transactionSignature: result.transactionSignature,
      finalizedSlot: BigInt(result.finalizedSlot),
      executedAtMs: BigInt(result.executedAtMs),
      status: result.status,
    });
  }
}
