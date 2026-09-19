import type {
  ExecutionGatewayServicePort,
  GatewayFakOrderRequest,
  GatewayJupiterSwapRequest,
  GatewayPredictOrderRequest,
  GatewayPusdTransferRequest,
  GatewaySolanaSplitRequest,
} from "./types.js";
import type { ClobOrderGateway } from "./clob-order-service.js";
import type { PolygonPusdTransferGateway } from "./polygon-transfer-service.js";
import type { SolanaUsdcSplitGateway } from "./solana-split-service.js";
import type { JupiterSwapGateway } from "./jupiter-swap-service.js";
import type { JupiterPredictOrderGateway } from "./predict-order-service.js";

export class ExecutionGatewayService implements ExecutionGatewayServicePort {
  public constructor(
    private readonly solana: SolanaUsdcSplitGateway,
    private readonly venues: Readonly<{
      /** Polygon prediction venue; absent when PREDICTION_VENUE is not polymarket. */
      clob?: ClobOrderGateway;
      polygon?: PolygonPusdTransferGateway;
      /** Solana-native prediction venue. */
      predict?: JupiterPredictOrderGateway;
      jupiter?: JupiterSwapGateway;
    }> = {},
  ) {}

  public signFakOrder(request: GatewayFakOrderRequest) {
    if (this.venues.clob === undefined) {
      throw new Error("Polymarket CLOB execution is not enabled on this gateway");
    }
    return this.venues.clob.signFakOrder(request);
  }

  public transferPusd(request: GatewayPusdTransferRequest) {
    if (this.venues.polygon === undefined) {
      throw new Error("Polygon pUSD transfers are not enabled on this gateway");
    }
    return this.venues.polygon.transferPusd(request);
  }

  public splitSolanaUsdc(request: GatewaySolanaSplitRequest) {
    return this.solana.splitSolanaUsdc(request);
  }

  public executeJupiterSwap(request: GatewayJupiterSwapRequest) {
    if (this.venues.jupiter === undefined) {
      throw new Error("Jupiter execution is not enabled on this gateway");
    }
    return this.venues.jupiter.executeExactIn(request);
  }

  public executePredictOrder(request: GatewayPredictOrderRequest) {
    if (this.venues.predict === undefined) {
      throw new Error("Jupiter Predict execution is not enabled on this gateway");
    }
    return this.venues.predict.executeOrder(request);
  }
}
