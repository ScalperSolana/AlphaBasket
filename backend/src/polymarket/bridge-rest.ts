import { z } from "zod";

import type {
  BridgeAddress,
  BridgeTransferObservation,
  PolymarketBridgePort,
} from "../execution/types.js";
import { JsonHttpClient } from "./http-json.js";

const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/u);
const svmAddress = z.string().min(32).max(64);
const addressSchema = z.object({
  address: z.object({ evm: evmAddress, svm: svmAddress }).passthrough(),
}).passthrough();
const statusValue = z.enum([
  "DEPOSIT_DETECTED",
  "PROCESSING",
  "ORIGIN_TX_CONFIRMED",
  "SUBMITTED",
  "COMPLETED",
  "FAILED",
]);
const integerText = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const statusSchema = z.object({
  transactions: z.array(z.object({
    fromAmountBaseUnit: integerText,
    toAmountBaseUnit: integerText.optional(),
    status: statusValue,
    txHash: z.string().min(1).optional(),
    createdTimeMs: z.union([integerText, z.number().int().nonnegative().safe().transform(String)]).optional(),
  }).passthrough()),
}).passthrough();

export interface PolymarketBridgeRestOptions {
  readonly baseUrl?: string;
  readonly builderCode?: string;
}

export class PolymarketBridgeRest implements PolymarketBridgePort {
  private readonly baseUrl: string;
  private readonly headers: Readonly<Record<string, string>>;

  public constructor(private readonly http: JsonHttpClient, options: PolymarketBridgeRestOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://bridge.polymarket.com").replace(/\/$/u, "");
    if (options.builderCode !== undefined && !/^0x[a-fA-F0-9]{64}$/u.test(options.builderCode)) {
      throw new TypeError("Polymarket builderCode must be bytes32 hex");
    }
    this.headers = Object.freeze(options.builderCode === undefined ? {} : { "X-Builder-Code": options.builderCode });
  }

  public async createDepositAddress(polymarketWallet: string): Promise<BridgeAddress> {
    if (!evmAddress.safeParse(polymarketWallet).success) throw new TypeError("invalid Polymarket wallet address");
    const result = await this.http.post(`${this.baseUrl}/deposit`, { address: polymarketWallet }, addressSchema, this.headers);
    return Object.freeze({ evm: result.address.evm, svm: result.address.svm });
  }

  public async createWithdrawalAddress(request: {
    readonly polymarketWallet: string;
    readonly solanaRecipient: string;
    readonly solanaChainId: string;
    readonly solanaUsdcMint: string;
  }): Promise<BridgeAddress> {
    if (!evmAddress.safeParse(request.polymarketWallet).success) throw new TypeError("invalid Polymarket wallet address");
    if (!svmAddress.safeParse(request.solanaRecipient).success || !svmAddress.safeParse(request.solanaUsdcMint).success) {
      throw new TypeError("invalid Solana withdrawal destination");
    }
    if (!/^[0-9]+$/u.test(request.solanaChainId)) throw new TypeError("invalid Solana chain ID");
    const result = await this.http.post(`${this.baseUrl}/withdraw`, {
      address: request.polymarketWallet,
      toChainId: request.solanaChainId,
      toTokenAddress: request.solanaUsdcMint,
      recipientAddr: request.solanaRecipient,
    }, addressSchema, this.headers);
    return Object.freeze({ evm: result.address.evm, svm: result.address.svm });
  }

  public async getStatus(bridgeAddress: string): Promise<readonly BridgeTransferObservation[]> {
    if (bridgeAddress.length < 16 || bridgeAddress.length > 256) throw new TypeError("invalid bridge address");
    const result = await this.http.get(`${this.baseUrl}/status/${encodeURIComponent(bridgeAddress)}`, statusSchema);
    const now = BigInt(Date.now());
    return Object.freeze(result.transactions.map((transaction) => {
      if (transaction.status === "COMPLETED" && (transaction.txHash === undefined || transaction.createdTimeMs === undefined)) {
        throw new Error("completed Polymarket bridge record is missing its transaction hash or creation time");
      }
      return Object.freeze({
      status: transaction.status,
      bridgeAddress,
      sourceTxHash: null,
      destinationTxHash: transaction.txHash ?? null,
      inputAmountUnits: BigInt(transaction.fromAmountBaseUnit),
      outputAmountUnits: transaction.toAmountBaseUnit === undefined ? null : BigInt(transaction.toAmountBaseUnit),
      observedAtMs: transaction.createdTimeMs === undefined ? now : BigInt(transaction.createdTimeMs),
      });
    }));
  }
}
