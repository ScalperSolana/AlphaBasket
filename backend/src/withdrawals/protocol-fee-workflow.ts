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
import { NOOP_FAULT_INJECTOR, type FaultInjectorPort } from "../resilience/index.js";
import type { FinancialExecutionGuardPort } from "../operations/index.js";
import type { WalletExecutionCoordinatorPort } from "../wallets/types.js";
import type {
  JupiterExactInResult,
  JupiterExecutionPort,
} from "../jupiter/index.js";

const assertLeaseActive = (signal: AbortSignal): void => {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("execution wallet lease was lost");
};

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
  readonly idleUsdcUnits?: bigint;
  readonly targets: readonly (
    WeightedExecutionTarget & ({
      readonly kind?: "prediction_market";
      readonly currentUnits: bigint;
      readonly worstSellPriceUnits: bigint;
      readonly negativeRisk: boolean;
    } | {
      readonly kind: "spot";
      readonly tokenMint: string;
      readonly currentUnits: bigint;
    })
  )[];
  readonly maxSlippageBps: number;
  readonly polymarketWallet: string;
  readonly walletId: string;
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
  readonly jupiterSwaps: readonly JupiterExactInResult[];
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
    private readonly executionGuard: FinancialExecutionGuardPort,
    private readonly walletCoordinator: WalletExecutionCoordinatorPort,
    private readonly faults: FaultInjectorPort = NOOP_FAULT_INJECTOR,
    private readonly jupiter: JupiterExecutionPort | null = null,
  ) {}

  public async execute(request: ProtocolFeeWithdrawalRequest): Promise<ProtocolFeeWithdrawalResult> {
    return this.walletCoordinator.execute(request.walletId, request.operationId, async (signal) => {
      assertLeaseActive(signal);
      await this.executionGuard.authorize({
        operationId: request.operationId,
        basketId: request.basket.toBase58(),
        walletId: request.walletId,
        amountUnits: valueForShares(request.shareAmount, request.sharePrice),
        now: request.now,
      });
      return this.executeLocked(request, signal);
    });
  }

  private async executeLocked(request: ProtocolFeeWithdrawalRequest, signal: AbortSignal): Promise<ProtocolFeeWithdrawalResult> {
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
    const jupiterSwaps: JupiterExactInResult[] = [];
    for (let index = 0; index < allocations.length; index += 1) {
      const allocation = allocations[index];
      const source = request.targets[index];
      if (allocation === undefined || source === undefined || allocation.amountUnits === 0n) continue;
      assertLeaseActive(signal);
      if (source.kind === "spot") {
        if (this.jupiter === null) {
          throw new Error("Jupiter execution is not configured for this mixed-basket protocol redemption");
        }
        const swap = await this.jupiter.executeExactIn({
          idempotencyKey: `${request.operationId}:protocol-spot-sell:${index}`,
          inputMint: new PublicKey(source.tokenMint),
          outputMint: new PublicKey(request.solanaUsdcMint),
          inputAmountUnits: allocation.amountUnits,
          slippageBps: request.maxSlippageBps,
          taker: new PublicKey(request.solanaSettlementReceiver),
        });
        if (
          !swap.inputMint.equals(new PublicKey(source.tokenMint)) ||
          !swap.outputMint.equals(new PublicKey(request.solanaUsdcMint)) ||
          swap.requestedInputUnits !== allocation.amountUnits ||
          swap.filledInputUnits <= 0n ||
          swap.filledInputUnits > allocation.amountUnits
        ) {
          throw new Error("invalid protocol-share Jupiter liquidation");
        }
        jupiterSwaps.push(swap);
        await this.faults.after("protocol_fee.jupiter_swap_executed", {
          operationId: request.operationId,
          metadata: {
            transactionSignature: swap.transactionSignature,
          },
        });
      } else {
        const order = await this.fak.executeFak({
          clientOrderId: `${request.operationId}:protocol-sell:${index}`,
          tokenId: allocation.tokenId,
          side: "sell",
          negativeRisk: source.negativeRisk,
          amountUnits: allocation.amountUnits,
          worstPriceUnits: source.worstSellPriceUnits,
        });
        orders.push(order);
        await this.faults.after("protocol_fee.fak_order_executed", {
          operationId: request.operationId,
          metadata: { clientOrderId: order.clientOrderId, orderId: order.orderId },
        });
      }
    }
    const proceeds = orders.reduce((sum, order) => sum + order.filledOutputUnits, 0n);
    const idleAllocation = (request.idlePusdUnits * request.shareAmount) / request.totalSharesOutstanding;
    const grossPusd = proceeds + idleAllocation;
    const idleUsdcAllocation =
      ((request.idleUsdcUnits ?? 0n) * request.shareAmount) /
      request.totalSharesOutstanding;
    const spotProceeds = jupiterSwaps.reduce(
      (sum, swap) => sum + swap.filledOutputUnits,
      0n,
    );
    const preBridgeGross =
      grossPusd + spotProceeds + idleUsdcAllocation;
    const initialMinimumGross = minimumAfterSlippage(valueForShares(request.shareAmount, request.sharePrice), request.maxSlippageBps);
    if (preBridgeGross < initialMinimumGross) throw new Error("protocol-share hybrid liquidation is below the configured slippage floor");
    if (operation.state === "intent_verified") {
      operation = await this.operations.transition(operation.id, operation.version, "trading_completed", {
        grossPusdUnits: grossPusd.toString(10),
        orderIds: orders.map((order) => order.orderId),
        idleUsdcUnits: idleUsdcAllocation.toString(10),
        jupiterTransactions:
          jupiterSwaps.map((swap) => swap.transactionSignature),
      }, request.now);
    }
    let bridgeAddress: string;
    let bridgeSourceTransaction: string | null;
    let bridgeObservedAtMs: bigint;
    let receipt: Readonly<{
      amountUnits: bigint;
      transactionSignature: string | null;
      finalizedSlot: bigint;
    }>;
    if (grossPusd === 0n) {
      bridgeAddress = "none";
      bridgeSourceTransaction = null;
      bridgeObservedAtMs = jupiterSwaps.reduce(
        (latest, swap) =>
          swap.executedAtMs > latest ? swap.executedAtMs : latest,
        BigInt(request.now.getTime()),
      );
      if (operation.state === "trading_completed") {
        operation = await this.operations.transition(
          operation.id,
          operation.version,
          "bridge_pending",
          {
            ...operation.checkpoint,
            bridgeAddress,
            bridgeObservedAtMs: bridgeObservedAtMs.toString(10),
          },
          request.now,
        );
      }
      receipt = Object.freeze({
        amountUnits: 0n,
        transactionSignature: null,
        finalizedSlot: 0n,
      });
    } else {
      if (operation.state === "trading_completed") {
        assertLeaseActive(signal);
        const address = await this.bridge.createWithdrawalAddress({
          polymarketWallet: request.polymarketWallet,
          solanaRecipient: request.solanaSettlementReceiver,
          solanaChainId: request.solanaChainId,
          solanaUsdcMint: request.solanaUsdcMint,
        });
        bridgeAddress = address.evm;
        operation = await this.operations.transition(operation.id, operation.version, "bridge_pending", {
          ...operation.checkpoint,
          bridgeAddress,
        }, request.now);
        await this.faults.after("protocol_fee.bridge_address_created", {
          operationId: request.operationId,
          metadata: { bridgeAddress },
        });
      } else {
        const stored = operation.checkpoint.bridgeAddress;
        if (typeof stored !== "string" || stored.length === 0) throw new Error("protocol withdrawal checkpoint is missing the bridge address");
        bridgeAddress = stored;
      }
      assertLeaseActive(signal);
      const transfer = await this.pusdTransfer.transferPusd({
        idempotencyKey: `${request.operationId}:protocol-bridge`,
        destinationEvmAddress: bridgeAddress,
        amountUnits: grossPusd,
      });
      bridgeSourceTransaction = transfer.transactionHash;
      await this.faults.after("protocol_fee.pusd_transfer_submitted", {
        operationId: request.operationId,
        metadata: { transactionHash: transfer.transactionHash },
      });
      if (operation.state === "bridge_pending" && operation.checkpoint.pusdTransferTransaction === undefined) {
        operation = await this.operations.transition(operation.id, operation.version, "bridge_pending", {
          ...operation.checkpoint,
          pusdTransferTransaction: transfer.transactionHash,
        }, request.now);
      }
      assertLeaseActive(signal);
      const observations = await this.bridge.getStatus(bridgeAddress);
      const operationCreatedAtMs = BigInt(operation.createdAt.getTime());
      const completed = observations.find((item) =>
        item.status === "COMPLETED" &&
        item.inputAmountUnits === grossPusd &&
        item.observedAtMs >= operationCreatedAtMs,
      );
      if (completed === undefined) {
        if (observations.some((item) => item.status === "FAILED")) throw new Error("protocol withdrawal bridge failed");
        if (operation.state === "bridge_pending") operation = await this.operations.transition(operation.id, operation.version, "bridge_pending", operation.checkpoint, request.now);
        throw new BridgePendingError(bridgeAddress);
      }
      bridgeObservedAtMs = completed.observedAtMs;
      assertLeaseActive(signal);
      receipt = await this.bridgeReceipt.verifyReceived({
        bridgeAddress,
        destination: request.solanaSettlementReceiver,
        mint: request.solanaUsdcMint,
        expectedMaximumUnits: grossPusd,
        destinationTransactionHash: completed.destinationTxHash,
      });
    }
    if (receipt.amountUnits > grossPusd) {
      throw new Error("protocol bridge receipt exceeds Polymarket proceeds");
    }
    const grossRealized =
      receipt.amountUnits + spotProceeds + idleUsdcAllocation;
    if (
      grossRealized < initialMinimumGross ||
      grossRealized > preBridgeGross
    ) {
      throw new Error("protocol hybrid receipt is outside the redemption bounds");
    }
    if (operation.state === "bridge_pending") {
      operation = await this.operations.transition(operation.id, operation.version, "bridge_completed", {
        ...operation.checkpoint,
        bridgeTransaction: receipt.transactionSignature ?? "none",
        receivedUsdcUnits: receipt.amountUnits.toString(10),
        receivedJupiterUsdcUnits: spotProceeds.toString(10),
      }, request.now);
    }
    const nowSeconds = BigInt(Math.floor(request.now.getTime() / 1_000));
    const pricing = await this.pricing.loadLatestPricing(request.basket);
    assertFreshSettlementPricing(pricing, nowSeconds);
    const refreshedMinimumGross = minimumAfterSlippage(
      valueForShares(request.shareAmount, pricing.sharePrice),
      request.maxSlippageBps,
    );
    if (grossRealized < refreshedMinimumGross) throw new Error("protocol redemption is below the refreshed on-chain slippage floor");
    assertLeaseActive(signal);
    const distribution = await this.splitter.distribute({
      idempotencyKey: `${request.operationId}:protocol-transfer`,
      sourceBridgeTransaction: receipt.transactionSignature,
      sourceBridgeAmountUnits: receipt.amountUnits,
      sourceJupiterTransactions:
        jupiterSwaps.map((swap) => swap.transactionSignature),
      idleUsdcAmountUnits: idleUsdcAllocation,
      mint: request.solanaUsdcMint,
      userDestination: request.protocolDestination,
      creatorDestination: request.protocolDestination,
      protocolDestination: request.protocolDestination,
      userAmountUnits: 0n,
      creatorAmountUnits: 0n,
      protocolAmountUnits: grossRealized,
    });
    await this.faults.after("protocol_fee.distribution_submitted", {
      operationId: request.operationId,
      metadata: { transactionSignature: distribution.transactionSignature },
    });
    const executedAt = orders.reduce(
      (latest, order) =>
        order.executedAtMs > latest ? order.executedAtMs : latest,
      jupiterSwaps.reduce(
        (latest, swap) =>
          swap.executedAtMs > latest ? swap.executedAtMs : latest,
        bridgeObservedAtMs,
      ),
    ) / 1_000n;
    assertExecutionTimestamp(executedAt, nowSeconds);
    const batch = executionBatchHash({
      kind: "protocol_fee_withdrawal",
      operationId: request.operationId,
      basket: request.basket.toBase58(),
      navReportHash: Buffer.from(pricing.navReportHash).toString("hex"),
      settlementNonce: request.settlementNonce,
      executedAtSeconds: executedAt,
      ...(bridgeSourceTransaction === null
        ? {}
        : { bridgeSourceTxHash: bridgeSourceTransaction }),
      ...(receipt.transactionSignature === null
        ? {}
        : {
            bridgeDestinationTxHash:
              receipt.transactionSignature,
          }),
      idlePusdUnits: idleAllocation,
      idleUsdcUnits: idleUsdcAllocation,
      orders,
      jupiterSwaps,
    });
    assertLeaseActive(signal);
    const settlement = await this.settlement.completeProtocolFeeWithdrawal({
      basket: request.basket,
      navReportHash: pricing.navReportHash,
      executionBatchHash: batch,
      executedAtSeconds: executedAt,
      settlementNonce: request.settlementNonce,
      shareAmount: request.shareAmount,
      basketNavValue: pricing.basketNavValue,
      sharePrice: pricing.sharePrice,
      grossRealizedValue: grossRealized,
    });
    await this.faults.after("protocol_fee.settlement_submitted", {
      operationId: request.operationId,
      metadata: { transactionSignature: settlement.transactionSignature },
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
      jupiterSwaps: Object.freeze(jupiterSwaps),
      grossRealizedValue: grossRealized,
      protocolTransferTransaction: distribution.transactionSignature,
      settlementTransaction: settlement.transactionSignature,
    });
  }
}
