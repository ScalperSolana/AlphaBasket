import { z } from "zod";

import type { PolymarketBalancePort } from "../execution/types.js";
import { JsonHttpClient } from "../polymarket/http-json.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
const resultSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().int(),
  result: z.string().regex(/^0x[0-9a-fA-F]{64}$/u),
}).passthrough();

export class PolygonPusdBalance implements PolymarketBalancePort {
  private readonly token: string;

  public constructor(
    private readonly http: JsonHttpClient,
    private readonly rpcUrl: string,
    tokenAddress: string,
  ) {
    if (!address.safeParse(tokenAddress).success) throw new TypeError("invalid Polygon pUSD token address");
    if (!/^https:\/\//u.test(rpcUrl) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?(?:\/|$)/u.test(rpcUrl)) {
      throw new TypeError("Polygon RPC URL must use HTTPS outside localhost development");
    }
    this.token = tokenAddress.toLowerCase();
  }

  public async getPusdBalanceUnits(polymarketWallet: string): Promise<bigint> {
    if (!address.safeParse(polymarketWallet).success) throw new TypeError("invalid Polymarket wallet address");
    const calldata = `0x70a08231${polymarketWallet.slice(2).toLowerCase().padStart(64, "0")}`;
    const response = await this.http.post(this.rpcUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: this.token, data: calldata }, "latest"],
    }, resultSchema);
    return BigInt(response.result);
  }
}
