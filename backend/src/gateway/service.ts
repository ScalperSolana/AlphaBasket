import type {
  ExecutionGatewayServicePort,
  GatewayFakOrderRequest,
  GatewayPusdTransferRequest,
  GatewaySolanaSplitRequest,
} from "./types.js";
import type { ClobOrderGateway } from "./clob-order-service.js";
import type { PolygonPusdTransferGateway } from "./polygon-transfer-service.js";
import type { SolanaUsdcSplitGateway } from "./solana-split-service.js";

export class ExecutionGatewayService implements ExecutionGatewayServicePort {
  public constructor(
    private readonly clob: ClobOrderGateway,
    private readonly polygon: PolygonPusdTransferGateway,
    private readonly solana: SolanaUsdcSplitGateway,
  ) {}

  public signFakOrder(request: GatewayFakOrderRequest) {
    return this.clob.signFakOrder(request);
  }

  public transferPusd(request: GatewayPusdTransferRequest) {
    return this.polygon.transferPusd(request);
  }

  public splitSolanaUsdc(request: GatewaySolanaSplitRequest) {
    return this.solana.splitSolanaUsdc(request);
  }
}
