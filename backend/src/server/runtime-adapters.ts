import type { PolymarketBridgePort } from "../execution/index.js";
import type {
  ExecutionWalletRegistryPort,
  StickyWalletAllocator,
} from "../wallets/index.js";
import type {
  DepositFundingRoutePort,
  ExecutionWalletRoute,
  ExecutionWalletRoutePort,
  SpotCompositionAdmissionPort,
} from "./application-service.js";
import type {
  JupiterPricePort,
  JupiterSpotEligibilityService,
  JupiterTokenAssetClass,
} from "../jupiter/index.js";
import { PublicKey } from "@solana/web3.js";

export class StickyExecutionWalletRoute implements ExecutionWalletRoutePort {
  public constructor(
    private readonly allocator: StickyWalletAllocator,
    private readonly registry: ExecutionWalletRegistryPort,
  ) {}

  public async allocate(basketId: string): Promise<ExecutionWalletRoute> {
    const assignment = await this.allocator.allocate(basketId);
    const wallet = (await this.registry.listWallets()).find(
      (candidate) => candidate.walletId === assignment.walletId,
    );
    if (wallet === undefined || wallet.status !== "active") {
      throw new Error("sticky execution wallet is missing or no longer active");
    }
    return Object.freeze({
      walletId: wallet.walletId,
      polygonAddress: wallet.polygonAddress.toLowerCase(),
    });
  }
}

export class LiveBridgeDepositFundingRoute implements DepositFundingRoutePort {
  public constructor(private readonly bridge: PolymarketBridgePort) {}

  public async createDepositFundingAddress(polymarketWallet: string): Promise<string> {
    return (await this.bridge.createDepositAddress(polymarketWallet)).svm;
  }
}

/** Explicit non-live staging route retained for local integration tests only. */
export class PrefundedStagingDepositFundingRoute implements DepositFundingRoutePort {
  public constructor(private readonly stagingDestination: string) {
    if (stagingDestination.length < 32 || stagingDestination.length > 64) {
      throw new TypeError("staging Solana funding destination is invalid");
    }
  }

  public async createDepositFundingAddress(_polymarketWallet: string): Promise<string> {
    return this.stagingDestination;
  }
}

export class JupiterSpotCompositionAdmission
implements SpotCompositionAdmissionPort {
  public constructor(
    private readonly eligibility: JupiterSpotEligibilityService,
    private readonly prices: JupiterPricePort,
    private readonly options: Readonly<{
      settlementMint: PublicKey;
      probeTaker: PublicKey;
      routeProbeAmountUnits: bigint;
      slippageBps: number;
    }>,
  ) {}

  public async admit(request: {
    readonly marketId: string;
    readonly tokenMint: PublicKey;
    readonly assetClass: JupiterTokenAssetClass;
    readonly weightBps: number;
  }) {
    const [eligible, prices] = await Promise.all([
      this.eligibility.requireEligible({
        tokenMint: request.tokenMint,
        assetClass: request.assetClass,
        settlementMint: this.options.settlementMint,
        routeProbeAmountUnits: this.options.routeProbeAmountUnits,
        probeTaker: this.options.probeTaker,
        slippageBps: this.options.slippageBps,
      }),
      this.prices.getUsdcPrices(
        [request.tokenMint],
        this.options.settlementMint,
      ),
    ]);
    const price = prices[0];
    if (price === undefined || !price.mint.equals(request.tokenMint)) {
      throw new Error("Jupiter returned no admission price for the selected spot token");
    }
    return Object.freeze({
      marketId: request.marketId,
      tokenMint: request.tokenMint,
      tokenDecimals: eligible.token.decimals,
      symbol: eligible.token.symbol,
      weightBps: request.weightBps,
      initialMarkPriceUnits: price.priceUsdcUnits,
      markSourceHash: price.sourceHash,
    });
  }
}
