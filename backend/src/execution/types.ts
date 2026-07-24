export type ExecutionKind = "deposit" | "withdrawal" | "protocol_fee_withdrawal";

export const EXECUTION_STATES = [
  "created",
  "intent_verified",
  "funding_verified",
  "bridge_pending",
  "bridge_completed",
  "trading_completed",
  "settlement_submitted",
  "completed",
  "failed",
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

export interface ExecutionOperation {
  readonly id: string;
  readonly requestKey: string;
  readonly requestHash: string;
  readonly kind: ExecutionKind;
  readonly state: ExecutionState;
  readonly workflowId: string;
  readonly basket: string;
  readonly userAddress?: string;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly version: bigint;
  readonly lastError?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt?: Date;
}

export interface NewExecutionOperation
  extends Omit<ExecutionOperation, "state" | "version" | "updatedAt" | "completedAt" | "lastError"> {
  readonly state?: "created";
}

export interface ExecutionOperationStore {
  createOrLoad(operation: NewExecutionOperation): Promise<{ readonly operation: ExecutionOperation; readonly created: boolean }>;
  transition(
    id: string,
    expectedVersion: bigint,
    nextState: ExecutionState,
    checkpoint: Readonly<Record<string, unknown>>,
    now: Date,
    error?: string,
  ): Promise<ExecutionOperation>;
}

export type OrderSide = "buy" | "sell";

export interface FakOrderRequest {
  readonly clientOrderId: string;
  readonly tokenId: string;
  readonly side: OrderSide;
  readonly negativeRisk: boolean;
  /** BUY: pUSD to spend. SELL: outcome-token units to sell. */
  readonly amountUnits: bigint;
  readonly worstPriceUnits: bigint;
}

export interface FakOrderResult {
  readonly clientOrderId: string;
  readonly orderId: string;
  readonly tokenId: string;
  readonly side: OrderSide;
  readonly requestedAmountUnits: bigint;
  readonly filledInputUnits: bigint;
  readonly filledOutputUnits: bigint;
  readonly averagePriceUnits: bigint | null;
  readonly status: "matched" | "partially_filled" | "unfilled";
  readonly transactionHashes: readonly string[];
  readonly tradeIds: readonly string[];
  readonly executedAtMs: bigint;
}

export interface FakExecutionPort {
  /** Implementations must return the original result when clientOrderId is replayed. */
  executeFak(request: FakOrderRequest): Promise<FakOrderResult>;
}

export type BridgeTransferStatus =
  | "DEPOSIT_DETECTED"
  | "PROCESSING"
  | "ORIGIN_TX_CONFIRMED"
  | "SUBMITTED"
  | "COMPLETED"
  | "FAILED";

export interface BridgeAddress {
  readonly svm: string;
  readonly evm: string;
}

export interface BridgeTransferObservation {
  readonly status: BridgeTransferStatus;
  readonly bridgeAddress: string;
  readonly sourceTxHash: string | null;
  readonly destinationTxHash: string | null;
  readonly inputAmountUnits: bigint;
  readonly outputAmountUnits: bigint | null;
  readonly observedAtMs: bigint;
}

export interface PolymarketBridgePort {
  createDepositAddress(polymarketWallet: string): Promise<BridgeAddress>;
  createWithdrawalAddress(request: {
    readonly polymarketWallet: string;
    readonly solanaRecipient: string;
    readonly solanaChainId: string;
    readonly solanaUsdcMint: string;
  }): Promise<BridgeAddress>;
  getStatus(bridgeAddress: string): Promise<readonly BridgeTransferObservation[]>;
}

export interface PolymarketBalancePort {
  getPusdBalanceUnits(polymarketWallet: string): Promise<bigint>;
}

export interface PolymarketCreditVerifierPort {
  verifyPusdCredit(request: {
    readonly destinationTransactionHash: string;
    readonly polymarketWallet: string;
    readonly expectedMaximumUnits: bigint;
  }): Promise<{ readonly amountUnits: bigint; readonly finalizedBlock: bigint }>;
}

export interface PolymarketPusdTransferPort {
  /** The idempotency key must map to a deterministic signed transfer transaction. */
  transferPusd(request: {
    readonly idempotencyKey: string;
    readonly destinationEvmAddress: string;
    readonly amountUnits: bigint;
  }): Promise<{ readonly transactionHash: string }>;
}

export interface SolanaFundingProof {
  readonly signature: string;
  readonly user: string;
  readonly bridgeAddress: string;
  readonly mint: string;
  readonly amountUnits: bigint;
  readonly finalizedSlot: bigint;
}

export interface SolanaFundingVerifierPort {
  verifyFinalizedTransfer(request: {
    readonly signature: string;
    readonly expectedUser: string;
    readonly expectedBridgeAddress: string;
    readonly expectedMint: string;
    readonly expectedAmountUnits: bigint;
  }): Promise<SolanaFundingProof>;
}

export interface SettlementResult {
  readonly transactionSignature: string;
  readonly receiptAddress: string;
  readonly finalizedSlot: bigint;
}

export interface SolanaAtomicSplitPort {
  distribute(request: {
    readonly idempotencyKey: string;
    readonly sourceBridgeTransaction: string;
    readonly mint: string;
    readonly userDestination: string;
    readonly creatorDestination: string;
    readonly protocolDestination: string;
    readonly userAmountUnits: bigint;
    readonly creatorAmountUnits: bigint;
    readonly protocolAmountUnits: bigint;
  }): Promise<{ readonly transactionSignature: string; readonly finalizedSlot: bigint }>;
}

export interface SolanaBridgeReceiptPort {
  verifyReceived(request: {
    readonly bridgeAddress: string;
    readonly destination: string;
    readonly mint: string;
    readonly expectedMaximumUnits: bigint;
    readonly destinationTransactionHash: string | null;
  }): Promise<{ readonly amountUnits: bigint; readonly transactionSignature: string; readonly finalizedSlot: bigint }>;
}
