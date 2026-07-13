import { minimumAfterSlippage, valueForShares } from "../accounting/math.js";
import { bytes32 } from "../contract/index.js";
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
import {
  assertExecutionTimestamp,
  assertFreshSettlementPricing,
  type SettlementPricingPort,
  type SolanaSettlementGatewayPort,
} from "../settlement/types.js";
import { BridgePendingError } from "../deposits/deposit-workflow.js";
import { PublicKey } from "@solana/web3.js";

export interface ProtocolFeeWithdrawalRequest {
  readonly operationId: string;
  readonly requestKey: string;
  readonly workflowId: string;
  readonly basket: PublicKey;
  readonly navReportHash: Uint8Array;
  readonly basketNavValue: bigint;
  readonly sharePrice: bigint;
  readonly shareAmount: bigint;
  readonly protocolFeeShares: bigint;
  readonly totalSharesOutstanding: bigint;
  readonly idlePusdUnits: bigint;
  readonly targets: readonly (WeightedExecutionTarget & { readonly currentUnits: bigint; readonly worstSellPriceUnits: bigint })[];
  readonly maxSlippageBps: number;
  readonly polymarketWallet: string;
  readonly protocolDestination: string;
  readonly solanaSettlementReceiver: string;
  readonly solanaUsdcMint: string;
  readonly solanaChainId: string;
  readonly settlementNonce: bigint;
  readonly now: Date;
}

export interface ProtocolFeeWithdrawalResult {
  readonly operation: ExecutionOperation;
  readonly executionBatchHash: string;
  readonly orders: readonly FakOrderResult[];
  readonly grossRealizedValue: bigint;
  readonly protocolTransferTransaction: string;
  readonly settlementTransaction: string;
}

export class ProtocolFeeWithdrawalWorkflow {
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

  public async execute(request: ProtocolFeeWithdrawalRequest): Promise<ProtocolFeeWithdrawalResult> {
    if (request.shareAmount <= 0n || request.shareAmount > request.protocolFeeShares) throw new RangeError("protocol share redemption exceeds available protocol shares");
    const navHash = bytes32(request.navReportHash, "navReportHash");
    const requestHash = executionRequestHash({
      kind: "protocol_fee_withdrawal",
      basket: request.basket.toBase58(),
      shareAmount: request.shareAmount,
      navReportHash: navHash.toString("hex"),
    });
    const loaded = await this.operations.createOrLoad({
      id: request.operationId,
      requestKey: request.requestKey,
      requestHash,
      kind: "protocol_fee_withdrawal",
      workflowId: request.workflowId,
      basket: request.basket.toBase58(),
      checkpoint: {},
      createdAt: request.now,
    });
    let operation = loaded.operation;
    if (operation.state === "created") {
      operation = await this.operations.transition(operation.id, operation.version, "intent_verified", {}, request.now);
    }
    const allocations = allocateProportionalLiquidation(request.shareAmount, request.totalSharesOutstanding, request.targets);
    const orders: FakOrderResult[] = [];
    for (let index = 0; index < allocations.length; index += 1) {
      const allocation = allocations[index];
      const source = request.targets[index];
      if (allocation === undefined || source === undefined || allocation.amountUnits === 0n) continue;
      orders.push(await this.fak.executeFak({
        clientOrderId: `${request.operationId}:protocol-sell:${index}`,
        tokenId: allocation.tokenId,
        side: "sell",
        amountUnits: allocation.amountUnits,
        worstPriceUnits: source.worstSellPriceUnits,
      }));
    }
    const proceeds = orders.reduce((sum, order) => sum + order.filledOutputUnits, 0n);
    const idleAllocation = (request.idlePusdUnits * request.shareAmount) / request.totalSharesOutstanding;
    const grossPusd = proceeds + idleAllocation;
    const initialMinimumGross = minimumAfterSlippage(valueForShares(request.shareAmount, request.sharePrice), request.maxSlippageBps);
    if (grossPusd < initialMinimumGross) throw new Error("protocol-share FAK liquidation is below the configured slippage floor");
    if (operation.state === "intent_verified") {
      operation = await this.operations.transition(operation.id, operation.version, "trading_completed", {
        grossPusdUnits: grossPusd.toString(10),
        orderIds: orders.map((order) => order.orderId),
      }, request.now);
    }
    const address = await this.bridge.createWithdrawalAddress({
      polymarketWallet: request.polymarketWallet,
      solanaRecipient: request.solanaSettlementReceiver,
      solanaChainId: request.solanaChainId,
      solanaUsdcMint: request.solanaUsdcMint,
    });
    const transfer = await this.pusdTransfer.transferPusd({
      idempotencyKey: `${request.operationId}:protocol-bridge`,
      destinationEvmAddress: address.evm,
      amountUnits: grossPusd,
    });
    if (operation.state === "trading_completed") {
      operation = await this.operations.transition(operation.id, operation.version, "bridge_pending", {
        ...operation.checkpoint,
        bridgeAddress: address.evm,
        pusdTransferTransaction: transfer.transactionHash,
      }, request.now);
    }
    const observations = await this.bridge.getStatus(address.evm);
    const operationCreatedAtMs = BigInt(operation.createdAt.getTime());
    const completed = observations.find((item) =>
      item.status === "COMPLETED" &&
      item.inputAmountUnits === grossPusd &&
      item.observedAtMs >= operationCreatedAtMs,
    );
    if (completed === undefined) {
      if (observations.some((item) => item.status === "FAILED")) throw new Error("protocol withdrawal bridge failed");
      if (operation.state === "bridge_pending") operation = await this.operations.transition(operation.id, operation.version, "bridge_pending", operation.checkpoint, request.now);
      throw new BridgePendingError(address.evm);
    }
    const receipt = await this.bridgeReceipt.verifyReceived({
      bridgeAddress: address.evm,
      destination: request.solanaSettlementReceiver,
      mint: request.solanaUsdcMint,
      expectedMaximumUnits: grossPusd,
      destinationTransactionHash: completed.destinationTxHash,
    });
    if (receipt.amountUnits < initialMinimumGross || receipt.amountUnits > grossPusd) throw new Error("protocol bridge receipt is outside the redemption bounds");
    if (operation.state === "bridge_pending") {
      operation = await this.operations.transition(operation.id, operation.version, "bridge_completed", {
        ...operation.checkpoint,
        bridgeTransaction: receipt.transactionSignature,
        receivedUsdcUnits: receipt.amountUnits.toString(10),
      }, request.now);
    }
    const nowSeconds = BigInt(Math.floor(request.now.getTime() / 1_000));
    const pricing = await this.pricing.loadLatestPricing(request.basket);
    assertFreshSettlementPricing(pricing, nowSeconds);
    const refreshedMinimumGross = minimumAfterSlippage(
      valueForShares(request.shareAmount, pricing.sharePrice),
      request.maxSlippageBps,
    );
    if (receipt.amountUnits < refreshedMinimumGross) throw new Error("protocol redemption is below the refreshed on-chain slippage floor");
    const distribution = await this.splitter.distribute({
      idempotencyKey: `${request.operationId}:protocol-transfer`,
      sourceBridgeTransaction: receipt.transactionSignature,
      mint: request.solanaUsdcMint,
      userDestination: request.protocolDestination,
      creatorDestination: request.protocolDestination,
      protocolDestination: request.protocolDestination,
      userAmountUnits: 0n,
      creatorAmountUnits: 0n,
      protocolAmountUnits: receipt.amountUnits,
    });
    const executedAt = orders.reduce((latest, order) => order.executedAtMs > latest ? order.executedAtMs : latest, completed.observedAtMs) / 1_000n;
    assertExecutionTimestamp(executedAt, nowSeconds);
    const batch = executionBatchHash({
      kind: "protocol_fee_withdrawal",
      operationId: request.operationId,
      basket: request.basket.toBase58(),
      navReportHash: Buffer.from(pricing.navReportHash).toString("hex"),
      settlementNonce: request.settlementNonce,
      executedAtSeconds: executedAt,
      bridgeSourceTxHash: transfer.transactionHash,
      bridgeDestinationTxHash: receipt.transactionSignature,
      idlePusdUnits: idleAllocation,
      orders,
    });
    const settlement = await this.settlement.completeProtocolFeeWithdrawal({
      basket: request.basket,
      navReportHash: pricing.navReportHash,
      executionBatchHash: batch,
      executedAtSeconds: executedAt,
      settlementNonce: request.settlementNonce,
      shareAmount: request.shareAmount,
      basketNavValue: pricing.basketNavValue,
      sharePrice: pricing.sharePrice,
      grossRealizedValue: receipt.amountUnits,
    });
    if (operation.state === "bridge_completed") {
      operation = await this.operations.transition(operation.id, operation.version, "settlement_submitted", {
        ...operation.checkpoint,
        executionBatchHash: batch.toString("hex"),
        protocolTransferTransaction: distribution.transactionSignature,
        settlementTransaction: settlement.transactionSignature,
      }, request.now);
    }
    if (operation.state === "settlement_submitted") operation = await this.operations.transition(operation.id, operation.version, "completed", operation.checkpoint, request.now);
    return Object.freeze({
      operation,
      executionBatchHash: batch.toString("hex"),
      orders: Object.freeze(orders),
      grossRealizedValue: receipt.amountUnits,
      protocolTransferTransaction: distribution.transactionSignature,
      settlementTransaction: settlement.transactionSignature,
    });
  }
}
