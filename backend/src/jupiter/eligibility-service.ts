import { PublicKey } from "@solana/web3.js";

import type {
  JupiterSpotEligibility,
  JupiterSwapBuildPort,
  JupiterTokenAssetClass,
  JupiterTokenDirectoryPort,
} from "./types.js";

export interface JupiterEligibilityRequest {
  readonly tokenMint: PublicKey;
  readonly assetClass: JupiterTokenAssetClass;
  readonly settlementMint: PublicKey;
  readonly routeProbeAmountUnits: bigint;
  readonly probeTaker: PublicKey;
  readonly slippageBps: number;
}

/**
 * Enforces the off-chain half of spot admission. The on-chain registry remains
 * the authoritative prospective gate used by basket creation.
 */
export class JupiterSpotEligibilityService {
  private readonly xStockMints: ReadonlySet<string>;

  public constructor(
    private readonly tokens: JupiterTokenDirectoryPort,
    private readonly swaps: JupiterSwapBuildPort,
    xStockMints: readonly PublicKey[],
  ) {
    this.xStockMints = new Set(xStockMints.map((mint) => mint.toBase58()));
  }

  public async requireEligible(
    request: JupiterEligibilityRequest,
  ): Promise<JupiterSpotEligibility> {
    const token = await this.tokens.requireVerified(request.tokenMint);
    if (
      request.assetClass === "tokenized-equity" &&
      (!token.tags.includes("stocks") ||
        !this.xStockMints.has(request.tokenMint.toBase58()))
    ) {
      throw new Error(
        `tokenized equity ${request.tokenMint.toBase58()} is not in the explicit xStocks registry`,
      );
    }
    const route = await this.swaps.buildExactIn({
      inputMint: request.settlementMint,
      outputMint: request.tokenMint,
      amountUnits: request.routeProbeAmountUnits,
      taker: request.probeTaker,
      slippageBps: request.slippageBps,
      maxAccounts: 64,
    });
    return Object.freeze({ token, route });
  }
}
