export type GatewayRequestKind = "fak_order" | "pusd_transfer" | "solana_split";

export interface PreparedGatewayRequest {
  readonly requestKey: string;
  readonly requestKind: GatewayRequestKind;
  readonly requestHash: string;
  readonly signedPayload: Uint8Array;
  readonly transactionReference: string | null;
  readonly state: "prepared" | "submitted" | "finalized";
  readonly result: Readonly<Record<string, unknown>> | null;
}

export interface GatewayRequestStorePort {
  prepare(request: {
    readonly requestKey: string;
    readonly requestKind: GatewayRequestKind;
    readonly requestHash: string;
    readonly build: () => Promise<{
      readonly signedPayload: Uint8Array;
      readonly transactionReference?: string;
    }>;
    readonly now: Date;
  }): Promise<PreparedGatewayRequest>;
  markSubmitted(requestKey: string, transactionReference: string, now: Date): Promise<void>;
  markFinalized(
    requestKey: string,
    transactionReference: string,
    result: Readonly<Record<string, unknown>>,
    now: Date,
  ): Promise<void>;
}

export interface GatewayFakOrderRequest {
  readonly requestHash: string;
  readonly deploymentMode: "local" | "hybrid_devnet" | "production_canary" | "production";
  readonly clientOrderId: string;
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly negativeRisk: boolean;
  readonly makerAmountUnits: bigint;
  readonly takerAmountUnits: bigint;
}

export interface GatewayFakOrderResult {
  readonly requestHash: string;
  readonly serializedBodyBase64: string;
  readonly authenticationHeaders: Readonly<Record<string, string>>;
}

export interface GatewayPusdTransferRequest {
  readonly requestHash: string;
  readonly deploymentMode: "local" | "hybrid_devnet" | "production_canary" | "production";
  readonly idempotencyKey: string;
  readonly destinationEvmAddress: string;
  readonly amountUnits: bigint;
}

export interface GatewaySolanaSplitRequest {
  readonly requestHash: string;
  readonly deploymentMode: "local" | "hybrid_devnet" | "production_canary" | "production";
  readonly idempotencyKey: string;
  readonly sourceBridgeTransaction: string;
  readonly mint: string;
  readonly userDestination: string;
  readonly creatorDestination: string;
  readonly protocolDestination: string;
  readonly userAmountUnits: bigint;
  readonly creatorAmountUnits: bigint;
  readonly protocolAmountUnits: bigint;
}

export interface ExecutionGatewayServicePort {
  signFakOrder(request: GatewayFakOrderRequest): Promise<GatewayFakOrderResult>;
  transferPusd(request: GatewayPusdTransferRequest): Promise<{
    readonly requestHash: string;
    readonly transactionHash: string;
  }>;
  splitSolanaUsdc(request: GatewaySolanaSplitRequest): Promise<{
    readonly requestHash: string;
    readonly transactionSignature: string;
    readonly finalizedSlot: bigint;
  }>;
}
