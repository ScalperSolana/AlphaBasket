import { z } from "zod";

import type { PolymarketCreditVerifierPort } from "../execution/types.js";
import { JsonHttpClient } from "../polymarket/http-json.js";

const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/u);
const hexQuantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u);
const hex32 = z.string().regex(/^0x[a-fA-F0-9]{64}$/u);
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const receiptSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().int(),
  result: z.object({
    status: hexQuantity,
    blockNumber: hexQuantity,
    logs: z.array(z.object({
      address: evmAddress,
      topics: z.array(hex32),
      data: z.string().regex(/^0x[a-fA-F0-9]{64}$/u),
      removed: z.boolean().optional().default(false),
    }).passthrough()),
  }).nullable(),
}).passthrough();
const blockNumberSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().int(),
  result: hexQuantity,
}).passthrough();

function recipientTopic(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

export class PolygonPusdCreditVerifier implements PolymarketCreditVerifierPort {
  private readonly pusdToken: string;
  private readonly minConfirmations: bigint;
  public constructor(
    private readonly http: JsonHttpClient,
    private readonly rpcUrl: string,
    pusdToken: string,
    minConfirmations = 64,
  ) {
    if (!evmAddress.safeParse(pusdToken).success) throw new TypeError("invalid Polygon pUSD token address");
    if (!/^https:\/\//u.test(rpcUrl) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?(?:\/|$)/u.test(rpcUrl)) {
      throw new TypeError("Polygon RPC URL must use HTTPS except on localhost");
    }
    this.pusdToken = pusdToken.toLowerCase();
    if (!Number.isSafeInteger(minConfirmations) || minConfirmations <= 0) throw new RangeError("minConfirmations must be a positive safe integer");
    this.minConfirmations = BigInt(minConfirmations);
  }

  public async verifyPusdCredit(request: {
    readonly destinationTransactionHash: string;
    readonly polymarketWallet: string;
    readonly expectedMaximumUnits: bigint;
  }): Promise<{ readonly amountUnits: bigint; readonly finalizedBlock: bigint }> {
    if (!hex32.safeParse(request.destinationTransactionHash).success) throw new TypeError("invalid Polygon transaction hash");
    if (!evmAddress.safeParse(request.polymarketWallet).success) throw new TypeError("invalid Polymarket wallet address");
    if (request.expectedMaximumUnits <= 0n) throw new RangeError("expected pUSD credit must be positive");
    const response = await this.http.post(this.rpcUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionReceipt",
      params: [request.destinationTransactionHash],
    }, receiptSchema);
    if (response.result === null || response.result.status !== "0x1") throw new Error("Polygon destination transaction is missing or failed");
    const block = BigInt(response.result.blockNumber);
    const headResponse = await this.http.post(this.rpcUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "eth_blockNumber",
      params: [],
    }, blockNumberSchema);
    const head = BigInt(headResponse.result);
    if (head < block || head - block + 1n < this.minConfirmations) throw new Error("Polygon pUSD credit has insufficient confirmations");
    const expectedRecipient = recipientTopic(request.polymarketWallet);
    let amount = 0n;
    for (const log of response.result.logs) {
      if (
        !log.removed &&
        log.address.toLowerCase() === this.pusdToken &&
        log.topics[0]?.toLowerCase() === transferTopic &&
        log.topics[2]?.toLowerCase() === expectedRecipient
      ) {
        amount += BigInt(log.data);
      }
    }
    if (amount <= 0n || amount > request.expectedMaximumUnits) throw new Error("Polygon transaction does not contain the bounded pUSD credit");
    return Object.freeze({ amountUnits: amount, finalizedBlock: block });
  }
}
