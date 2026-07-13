import {
  calculateWithdrawalSettlement,
  minimumAfterSlippage,
  valueForShares,
} from "../accounting/math.js";
import { allocateProportionalLiquidation, type WeightedExecutionTarget } from "../execution/allocation.js";
import { executionBatchHash, executionRequestHash } from "../execution/hashes.js";
import type {
  ExecutionOperation,
  ExecutionOperationStore,
  FakExecutionPort,
  FakOrderResult,
  PolymarketBridgePort,
  PolymarketPusdTransferPort,
  SolanaAtomicSplitPort,
  SolanaBridgeReceiptPort,
} from "../execution/types.js";
import type { SignedWithdrawalIntent } from "../quotes/types.js";
import {
  assertExecutionTimestamp,
  assertFreshSettlementPricing,
  type SettlementPricingPort,
  type SolanaSettlementGatewayPort,
} from "../settlement/types.js";
import { BridgePendingError } from "../deposits/deposit-workflow.js";

export interface WithdrawalWorkflowRequest {
  readonly operationId: string;
  readonly requestKey: string;
  readonly workflowId: string;
  readonly intent: SignedWithdrawalIntent;
  readonly polymarketWallet: string;
  readonly totalSharesOutstanding: bigint;
  readonly positionSharesOwned: bigint;
  readonly positionCostBasisValue: bigint;
  readonly weightedDepositTimestamp: bigint;
  readonly idlePusdUnits: bigint;
  readonly targets: readonly (WeightedExecutionTarget & { readonly currentUnits: bigint; readonly worstSellPriceUnits: bigint })[];
  readonly performanceFeeBps: number;
  readonly maxSlippageBps: number;
  readonly creatorDestination: string;
  readonly protocolDestination: string;
  readonly solanaSettlementReceiver: string;
  readonly solanaUsdcMint: string;
  readonly solanaChainId: string;
  readonly settlementNonce: bigint;
  readonly now: Date;
}

export interface WithdrawalWorkflowResult {
  readonly operation: ExecutionOperation;
  readonly executionBatchHash: string;
  readonly orders: readonly FakOrderResult[];
  readonly grossRealizedValue: bigint;
  readonly protocolFee: bigint;
  readonly creatorFee: bigint;
  readonly userValueOut: bigint;
  readonly bridgeTransaction: string;
  readonly splitTransaction: string;
  readonly settlementTransaction: string;
}

export class WithdrawalWorkflow {
  public constructor(
    private readonly operations: ExecutionOperationStore,
    private readonly fak: FakExecutionPort,
    private readonly bridge: PolymarketBridgePort,
    private readonly pusdTransfer: PolymarketPusdTransferPort,
    private readonly bridgeReceipt: SolanaBridgeReceiptPort,
    private readonly splitter: SolanaAtomicSplitPort,
    private readonly pricing: SettlementPricingPort,
    private readonly settlement: SolanaSettlementGatewayPort,
  ) {}

  public async execute(request: WithdrawalWorkflowRequest): Promise<WithdrawalWorkflowResult> {
    const quote = request.intent.quote;
    const requestHash = executionRequestHash({
      kind: "withdrawal",
      basket: quote.basket.toBase58(),
      user: quote.user.toBase58(),
      intentHash: request.intent.intentHash.toString("hex"),
      shareAmount: quote.shareAmount,
    });
    const loaded = await this.operations.createOrLoad({
      id: request.operationId,
      requestKey: request.requestKey,
      requestHash,
      kind: "withdrawal",
      workflowId: request.workflowId,
      basket: quote.basket.toBase58(),
      userAddress: quote.user.toBase58(),
      checkpoint: {},
      createdAt: request.now,
    });
    let operation = loaded.operation;
    if (operation.state === "created") {
      operation = await this.operations.transition(operation.id, operation.version, "intent_verified", {
        intentHash: request.intent.intentHash.toString("hex"),
      }, request.now);
    }
    const allocations = allocateProportionalLiquidation(
      quote.shareAmount,
      request.totalSharesOutstanding,
      request.targets,
    );
    const orders: FakOrderResult[] = [];
    for (let index = 0; index < allocations.length; index += 1) {
      const allocation = allocations[index];
      const source = request.targets[index];
      if (allocation === undefined || source === undefined || allocation.amountUnits === 0n) continue;
      orders.push(await this.fak.executeFak({
        clientOrderId: `${request.operationId}:sell:${index}`,
        tokenId: allocation.tokenId,
        side: "sell",
        amountUnits: allocation.amountUnits,
        worstPriceUnits: source.worstSellPriceUnits,
      }));
    }
    const sellProceeds = orders.reduce((sum, order) => sum + order.filledOutputUnits, 0n);
    const idleAllocation = (request.idlePusdUnits * quote.shareAmount) / request.totalSharesOutstanding;
    const grossPusd = sellProceeds + idleAllocation;
    if (grossPusd < quote.minimumGrossValue) {
      throw new Error("partial FAK liquidation produced less than the signed minimum gross value");
    }
    if (operation.state === "intent_verified") {
      operation = await this.operations.transition(operation.id, operation.version, "trading_completed", {
        grossPusdUnits: grossPusd.toString(10),
        idlePusdUnits: idleAllocation.toString(10),
        orderIds: orders.map((order) => order.orderId),
      }, request.now);
    }
    const withdrawalAddress = await this.bridge.createWithdrawalAddress({
      polymarketWallet: request.polymarketWallet,
      solanaRecipient: request.solanaSettlementReceiver,
      solanaChainId: request.solanaChainId,
      solanaUsdcMint: request.solanaUsdcMint,
    });
    const transfer = await this.pusdTransfer.transferPusd({
      idempotencyKey: `${request.operationId}:bridge-withdrawal`,
      destinationEvmAddress: withdrawalAddress.evm,
      amountUnits: grossPusd,
    });
    if (operation.state === "trading_completed") {
      operation = await this.operations.transition(operation.id, operation.version, "bridge_pending", {
        ...operation.checkpoint,
        bridgeAddress: withdrawalAddress.evm,
        pusdTransferTransaction: transfer.transactionHash,
      }, request.now);
    }
    const observations = await this.bridge.getStatus(withdrawalAddress.evm);
    const operationCreatedAtMs = BigInt(operation.createdAt.getTime());
    const completed = observations.find((item) =>
      item.status === "COMPLETED" &&
      item.inputAmountUnits === grossPusd &&
      item.observedAtMs >= operationCreatedAtMs,
    );
    if (completed === undefined) {
      if (observations.some((item) => item.status === "FAILED")) throw new Error("Polymarket withdrawal bridge failed");
      if (operation.state === "bridge_pending") operation = await this.operations.transition(operation.id, operation.version, "bridge_pending", operation.checkpoint, request.now);
      throw new BridgePendingError(withdrawalAddress.evm);
    }
    const receipt = await this.bridgeReceipt.verifyReceived({
      bridgeAddress: withdrawalAddress.evm,
      destination: request.solanaSettlementReceiver,
      mint: request.solanaUsdcMint,
      expectedMaximumUnits: grossPusd,
      destinationTransactionHash: completed.destinationTxHash,
    });
    if (receipt.amountUnits < quote.minimumGrossValue || receipt.amountUnits > grossPusd) {
      throw new Error("bridged USDC amount is outside the signed withdrawal bounds");
    }
    if (operation.state === "bridge_pending") {
      operation = await this.operations.transition(operation.id, operation.version, "bridge_completed", {
        ...operation.checkpoint,
        bridgeTransaction: receipt.transactionSignature,
        receivedUsdcUnits: receipt.amountUnits.toString(10),
      }, request.now);
    }
    const nowSeconds = BigInt(Math.floor(request.now.getTime() / 1_000));
    if (request.maxSlippageBps !== quote.maxSlippageBps) throw new Error("withdrawal slippage policy differs from the signed quote");
    const pricing = await this.pricing.loadLatestPricing(quote.basket);
    assertFreshSettlementPricing(pricing, nowSeconds);
    const currentMinimumGross = minimumAfterSlippage(
      valueForShares(quote.shareAmount, pricing.sharePrice),
      request.maxSlippageBps,
    );
    if (receipt.amountUnits < currentMinimumGross) throw new Error("withdrawal execution is below the refreshed on-chain slippage floor");
    const fees = calculateWithdrawalSettlement(
      request.positionCostBasisValue,
      request.positionSharesOwned,
      request.weightedDepositTimestamp,
      quote.shareAmount,
      receipt.amountUnits,
      nowSeconds,
      request.performanceFeeBps,
    );
    if (fees.userValueOut < quote.minValueOut) throw new Error("withdrawal user output is below the signed minimum");
    const split = await this.splitter.distribute({
      idempotencyKey: `${request.operationId}:fee-split`,
      sourceBridgeTransaction: receipt.transactionSignature,
      mint: request.solanaUsdcMint,
      userDestination: request.intent.destination.toBase58(),
      creatorDestination: request.creatorDestination,
      protocolDestination: request.protocolDestination,
      userAmountUnits: fees.userValueOut,
      creatorAmountUnits: fees.creatorFee,
      protocolAmountUnits: fees.protocolFee,
    });
    const executedAt = orders.reduce((latest, order) => order.executedAtMs > latest ? order.executedAtMs : latest, completed.observedAtMs) / 1_000n;
    assertExecutionTimestamp(executedAt, nowSeconds);
    const batch = executionBatchHash({
      kind: "withdrawal",
      operationId: request.operationId,
      basket: quote.basket.toBase58(),
      navReportHash: Buffer.from(pricing.navReportHash).toString("hex"),
      settlementNonce: request.settlementNonce,
      executedAtSeconds: executedAt,
      bridgeSourceTxHash: transfer.transactionHash,
      bridgeDestinationTxHash: receipt.transactionSignature,
      idlePusdUnits: idleAllocation,
      orders,
    });
    const completedSettlement = await this.settlement.completeWithdrawal({
      intent: request.intent,
      navReportHash: pricing.navReportHash,
      executionBatchHash: batch,
      executedAtSeconds: executedAt,
      settlementNonce: request.settlementNonce,
      basketNavValue: pricing.basketNavValue,
      sharePrice: pricing.sharePrice,
      grossRealizedValue: receipt.amountUnits,
      protocolFee: fees.protocolFee,
      creatorFee: fees.creatorFee,
      userValueOut: fees.userValueOut,
    });
    if (operation.state === "bridge_completed") {
      operation = await this.operations.transition(operation.id, operation.version, "settlement_submitted", {
        ...operation.checkpoint,
        executionBatchHash: batch.toString("hex"),
        splitTransaction: split.transactionSignature,
        settlementTransaction: completedSettlement.transactionSignature,
      }, request.now);
    }
    if (operation.state === "settlement_submitted") {
      operation = await this.operations.transition(operation.id, operation.version, "completed", operation.checkpoint, request.now);
    }
    return Object.freeze({
      operation,
      executionBatchHash: batch.toString("hex"),
      orders: Object.freeze(orders),
      grossRealizedValue: receipt.amountUnits,
      protocolFee: fees.protocolFee,
      creatorFee: fees.creatorFee,
      userValueOut: fees.userValueOut,
      bridgeTransaction: receipt.transactionSignature,
      splitTransaction: split.transactionSignature,
      settlementTransaction: completedSettlement.transactionSignature,
    });
  }
}
