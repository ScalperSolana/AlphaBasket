import type { PolymarketBridgePort } from "../execution/index.js";
import type {
  ExecutionWalletRegistryPort,
  StickyWalletAllocator,
} from "../wallets/index.js";
import type {
  DepositFundingRoutePort,
  ExecutionWalletRoute,
  ExecutionWalletRoutePort,
} from "./application-service.js";

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
