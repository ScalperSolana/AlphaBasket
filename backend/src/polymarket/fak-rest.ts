import { z } from "zod";

import type { FakExecutionPort, FakOrderRequest, FakOrderResult } from "../execution/types.js";
import { PRICE_SCALE } from "./types.js";
import { JsonHttpClient } from "./http-json.js";

const integerText = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const responseSchema = z.object({
  success: z.boolean(),
  orderID: z.string().min(1),
  status: z.enum(["live", "matched", "delayed"]),
  makingAmount: integerText,
  takingAmount: integerText,
  transactionsHashes: z.array(z.string().min(1)).optional().default([]),
  tradeIDs: z.array(z.string().min(1)).optional().default([]),
  errorMsg: z.string(),
}).passthrough();

export interface SignedClobOrderEnvelope {
  readonly owner: string;
  readonly order: Readonly<Record<string, unknown>>;
  readonly authenticationHeaders: Readonly<Record<string, string>>;
}

export interface ClobOrderSignerPort {
  signFakOrder(request: {
    readonly clientOrderId: string;
    readonly tokenId: string;
    readonly side: "BUY" | "SELL";
    readonly makerAmountUnits: bigint;
    readonly takerAmountUnits: bigint;
  }): Promise<SignedClobOrderEnvelope>;
}

function orderAmounts(request: FakOrderRequest): { readonly maker: bigint; readonly taker: bigint } {
  if (request.amountUnits <= 0n || request.worstPriceUnits <= 0n || request.worstPriceUnits >= PRICE_SCALE) {
    throw new RangeError("FAK amount and worst price must be within valid ranges");
  }
  if (request.side === "buy") {
    const shares = (request.amountUnits * PRICE_SCALE) / request.worstPriceUnits;
    if (shares === 0n) throw new RangeError("FAK buy rounds to zero shares");
    return { maker: request.amountUnits, taker: shares };
  }
  const proceeds = (request.amountUnits * request.worstPriceUnits) / PRICE_SCALE;
  if (proceeds === 0n) throw new RangeError("FAK sell rounds to zero proceeds");
  return { maker: request.amountUnits, taker: proceeds };
}

export class ClobFakRestExecution implements FakExecutionPort {
  private readonly baseUrl: string;
  public constructor(
    private readonly http: JsonHttpClient,
    private readonly signer: ClobOrderSignerPort,
    options: { readonly baseUrl?: string } = {},
  ) {
    this.baseUrl = (options.baseUrl ?? "https://clob.polymarket.com").replace(/\/$/u, "");
  }

  public async executeFak(request: FakOrderRequest): Promise<FakOrderResult> {
    if (request.clientOrderId.length === 0 || request.tokenId.length === 0) throw new TypeError("FAK identifiers must not be empty");
    const amounts = orderAmounts(request);
    const envelope = await this.signer.signFakOrder({
      clientOrderId: request.clientOrderId,
      tokenId: request.tokenId,
      side: request.side === "buy" ? "BUY" : "SELL",
      makerAmountUnits: amounts.maker,
      takerAmountUnits: amounts.taker,
    });
    const raw = await this.http.post(`${this.baseUrl}/order`, {
      order: envelope.order,
      owner: envelope.owner,
      orderType: "FAK",
      deferExec: false,
      postOnly: false,
    }, responseSchema, envelope.authenticationHeaders);
    if (!raw.success || raw.status === "live" || raw.errorMsg.length > 0) {
      throw new Error(`Polymarket rejected FAK order: ${raw.errorMsg || raw.status}`);
    }
    const making = BigInt(raw.makingAmount);
    const taking = BigInt(raw.takingAmount);
    if (making > amounts.maker || taking > amounts.taker || (making === 0n) !== (taking === 0n)) {
      throw new Error("Polymarket returned invalid FAK fill amounts");
    }
    const averagePrice = making === 0n ? null : request.side === "buy"
      ? (making * PRICE_SCALE) / taking
      : (taking * PRICE_SCALE) / making;
    return Object.freeze({
      clientOrderId: request.clientOrderId,
      orderId: raw.orderID,
      tokenId: request.tokenId,
      side: request.side,
      requestedAmountUnits: request.amountUnits,
      filledInputUnits: making,
      filledOutputUnits: taking,
      averagePriceUnits: averagePrice,
      status: making === 0n ? "unfilled" : making === amounts.maker ? "matched" : "partially_filled",
      transactionHashes: Object.freeze(raw.transactionsHashes),
      tradeIds: Object.freeze(raw.tradeIDs),
      executedAtMs: BigInt(Date.now()),
    });
  }
}
