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
import type { FinancialExecutionGuardPort } from "../operations/index.js";
import { NOOP_FAULT_INJECTOR, type FaultInjectorPort } from "../resilience/index.js";
import {
  assertExecutionTimestamp,
  assertFreshSettlementPricing,
  type SettlementPricingPort,
  type SolanaSettlementGatewayPort,
} from "../settlement/types.js";
import { BridgePendingError } from "../deposits/deposit-workflow.js";
import type { WalletExecutionCoordinatorPort } from "../wallets/types.js";
import {
  PublicKey,
} from "@solana/web3.js";
import type {
  JupiterExactInResult,
  JupiterExecutionPort,
} from "../jupiter/index.js";

const assertLeaseActive = (signal: AbortSignal): void => {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("execution wallet lease was lost");
};

export interface WithdrawalWorkflowRequest {
  readonly operationId: string;
  readonly requestKey: string;
  readonly workflowId: string;
  readonly intent: SignedWithdrawalIntent;
  readonly polymarketWallet: string;
  readonly walletId: string;
  readonly totalSharesOutstanding: bigint;
  readonly positionSharesOwned: bigint;
  readonly positionCostBasisValue: bigint;
  readonly weightedDepositTimestamp: bigint;
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
  readonly performanceFeeBps: number;
  readonly maxSlippageBps: number;
  readonly creatorDestination: string;
  readonly protocolDestination: string;
  readonly solanaSettlementReceiver: string;
  readonly solanaUsdcMint: string;
  readonly solanaChainId: string;
  readonly settlementNonce: bigint;
  /** Optional local/staging execution path; hybrid_devnet uses live_bridge. */
  readonly capitalMode?: "prefunded_staging" | "live_bridge";
  /** Runs under the same exclusive wallet lease immediately before external execution. */
  readonly beforeExecution?: () => Promise<void>;
  /** Exactly-once portfolio attribution hook, still under the wallet lease. */
  readonly afterSettlement?: (result: WithdrawalWorkflowResult) => Promise<void>;
  readonly now: Date;
}

export interface WithdrawalWorkflowResult {
  readonly operation: ExecutionOperation;
  readonly executionBatchHash: string;
  readonly orders: readonly FakOrderResult[];
  readonly jupiterSwaps: readonly JupiterExactInResult[];
  readonly idleUsdcConsumed: bigint;
  readonly grossRealizedValue: bigint;
  readonly protocolFee: bigint;
  readonly creatorFee: bigint;
  readonly userValueOut: bigint;
  readonly bridgeTransaction: string | null;
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
    private readonly executionGuard: FinancialExecutionGuardPort,
    private readonly walletCoordinator: WalletExecutionCoordinatorPort,
    private readonly faults: FaultInjectorPort = NOOP_FAULT_INJECTOR,
    private readonly jupiter: JupiterExecutionPort | null = null,
  ) {}

  public async execute(request: WithdrawalWorkflowRequest): Promise<WithdrawalWorkflowResult> {
    return this.walletCoordinator.execute(request.walletId, request.operationId, async (signal) => {
      assertLeaseActive(signal);
      await this.executionGuard.authorize({
        operationId: request.operationId,
        basketId: request.intent.quote.basket.toBase58(),
        walletId: request.walletId,
        amountUnits: request.intent.quote.quotedGrossValue,
        now: request.now,
      });
      await request.beforeExecution?.();
      const result = await this.executeLocked(request, signal);
      await request.afterSettlement?.(result);
      return result;
    });
  }

  private async executeLocked(request: WithdrawalWorkflowRequest, signal: AbortSignal): Promise<WithdrawalWorkflowResult> {
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
    const jupiterSwaps: JupiterExactInResult[] = [];
    for (let index = 0; index < allocations.length; index += 1) {
      const allocation = allocations[index];
      const source = request.targets[index];
      if (allocation === undefined || source === undefined || allocation.amountUnits === 0n) continue;
      assertLeaseActive(signal);
      if (source.kind === "spot") {
        if (this.jupiter === null) {
          throw new Error("Jupiter execution is not configured for this spot or mixed basket");
        }
        const swap = await this.jupiter.executeExactIn({
          idempotencyKey: `${request.operationId}:spot-sell:${index}`,
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
          throw new Error("invalid Jupiter withdrawal fill");
        }
        jupiterSwaps.push(swap);
        await this.faults.after("withdrawal.jupiter_swap_executed", {
          operationId: request.operationId,
          metadata: { transactionSignature: swap.transactionSignature },
        });
      } else {
        const order = await this.fak.executeFak({
          clientOrderId: `${request.operationId}:sell:${index}`,
          tokenId: allocation.tokenId,
          side: "sell",
          negativeRisk: source.negativeRisk,
          amountUnits: allocation.amountUnits,
          worstPriceUnits: source.worstSellPriceUnits,
        });
        orders.push(order);
        await this.faults.after("withdrawal.fak_order_executed", {
          operationId: request.operationId,
          metadata: { clientOrderId: order.clientOrderId, orderId: order.orderId },
        });
      }
    }
    const sellProceeds = orders.reduce((sum, order) => sum + order.filledOutputUnits, 0n);
    const idleAllocation = (request.idlePusdUnits * quote.shareAmount) / request.totalSharesOutstanding;
    const grossPusd = sellProceeds + idleAllocation;
    const idleUsdcAllocation =
      ((request.idleUsdcUnits ?? 0n) * quote.shareAmount) /
      request.totalSharesOutstanding;
    const spotProceeds = jupiterSwaps.reduce(
      (sum, swap) => sum + swap.filledOutputUnits,
      0n,
    );
    const preBridgeGross = grossPusd + spotProceeds + idleUsdcAllocation;
    if (preBridgeGross < quote.minimumGrossValue) {
      throw new Error("partial FAK liquidation produced less than the signed minimum gross value");
    }
    if (operation.state === "intent_verified") {
      operation = await this.operations.transition(operation.id, operation.version, "trading_completed", {
        grossPusdUnits: grossPusd.toString(10),
        idlePusdUnits: idleAllocation.toString(10),
        idleUsdcUnits: idleUsdcAllocation.toString(10),
        orderIds: orders.map((order) => order.orderId),
        jupiterTransactions: jupiterSwaps.map((swap) => swap.transactionSignature),
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
        (latest, swap) => swap.executedAtMs > latest ? swap.executedAtMs : latest,
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
    } else if (request.capitalMode === "prefunded_staging") {
      bridgeAddress = `prefunded:${request.operationId}`;
      bridgeSourceTransaction = `prefunded-pusd:${request.operationId}`;
      const storedObservedAtMs = operation.checkpoint.bridgeObservedAtMs;
      bridgeObservedAtMs = typeof storedObservedAtMs === "string"
        ? BigInt(storedObservedAtMs)
        : BigInt(request.now.getTime());
      if (operation.state === "trading_completed") {
        operation = await this.operations.transition(operation.id, operation.version, "bridge_pending", {
          ...operation.checkpoint,
          bridgeAddress,
          pusdTransferTransaction: bridgeSourceTransaction,
          bridgeObservedAtMs: bridgeObservedAtMs.toString(10),
        }, request.now);
      }
      receipt = Object.freeze({
        amountUnits: grossPusd,
        transactionSignature: `prefunded-usdc:${request.operationId}`,
        finalizedSlot: 0n,
      });
    } else {
      if (operation.state === "trading_completed") {
        assertLeaseActive(signal);
        const withdrawalAddress = await this.bridge.createWithdrawalAddress({
          polymarketWallet: request.polymarketWallet,
          solanaRecipient: request.solanaSettlementReceiver,
          solanaChainId: request.solanaChainId,
          solanaUsdcMint: request.solanaUsdcMint,
        });
        bridgeAddress = withdrawalAddress.evm;
        operation = await this.operations.transition(operation.id, operation.version, "bridge_pending", {
          ...operation.checkpoint,
          bridgeAddress,
        }, request.now);
        await this.faults.after("withdrawal.bridge_address_created", {
          operationId: request.operationId,
          metadata: { bridgeAddress },
        });
      } else {
        const stored = operation.checkpoint.bridgeAddress;
        if (typeof stored !== "string" || stored.length === 0) throw new Error("withdrawal checkpoint is missing the bridge address");
        bridgeAddress = stored;
      }
      assertLeaseActive(signal);
      const transfer = await this.pusdTransfer.transferPusd({
        idempotencyKey: `${request.operationId}:bridge-withdrawal`,
        destinationEvmAddress: bridgeAddress,
        amountUnits: grossPusd,
      });
      bridgeSourceTransaction = transfer.transactionHash;
      await this.faults.after("withdrawal.pusd_transfer_submitted", {
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
        if (observations.some((item) => item.status === "FAILED")) throw new Error("Polymarket withdrawal bridge failed");
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
      throw new Error("bridged USDC amount exceeds the liquidated Polymarket value");
    }
    const grossRealized = receipt.amountUnits + spotProceeds + idleUsdcAllocation;
    if (grossRealized < quote.minimumGrossValue || grossRealized > preBridgeGross) {
      throw new Error("hybrid realized USDC amount is outside the signed withdrawal bounds");
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
    if (request.maxSlippageBps !== quote.maxSlippageBps) throw new Error("withdrawal slippage policy differs from the signed quote");
    const pricing = await this.pricing.loadLatestPricing(quote.basket);
    assertFreshSettlementPricing(pricing, nowSeconds);
    const currentMinimumGross = minimumAfterSlippage(
      valueForShares(quote.shareAmount, pricing.sharePrice),
      request.maxSlippageBps,
    );
    if (grossRealized < currentMinimumGross) throw new Error("withdrawal execution is below the refreshed on-chain slippage floor");
    const fees = calculateWithdrawalSettlement(
      request.positionCostBasisValue,
      request.positionSharesOwned,
      request.weightedDepositTimestamp,
      quote.shareAmount,
      grossRealized,
      nowSeconds,
      request.performanceFeeBps,
    );
    if (fees.userValueOut < quote.minValueOut) throw new Error("withdrawal user output is below the signed minimum");
    assertLeaseActive(signal);
    const split = await this.splitter.distribute({
      idempotencyKey: `${request.operationId}:fee-split`,
      sourceBridgeTransaction: receipt.transactionSignature,
      sourceBridgeAmountUnits: receipt.amountUnits,
      sourceJupiterTransactions: jupiterSwaps.map((swap) => swap.transactionSignature),
      idleUsdcAmountUnits: idleUsdcAllocation,
      mint: request.solanaUsdcMint,
      userDestination: request.intent.destination.toBase58(),
      creatorDestination: request.creatorDestination,
      protocolDestination: request.protocolDestination,
      userAmountUnits: fees.userValueOut,
      creatorAmountUnits: fees.creatorFee,
      protocolAmountUnits: fees.protocolFee,
    });
    await this.faults.after("withdrawal.fee_split_submitted", {
      operationId: request.operationId,
      metadata: { transactionSignature: split.transactionSignature },
    });
    const executedAt = orders.reduce(
      (latest, order) => order.executedAtMs > latest ? order.executedAtMs : latest,
      jupiterSwaps.reduce(
        (latest, swap) => swap.executedAtMs > latest ? swap.executedAtMs : latest,
        bridgeObservedAtMs,
      ),
    ) / 1_000n;
    assertExecutionTimestamp(executedAt, nowSeconds);
    const batch = executionBatchHash({
      kind: "withdrawal",
      operationId: request.operationId,
      basket: quote.basket.toBase58(),
      navReportHash: Buffer.from(pricing.navReportHash).toString("hex"),
      settlementNonce: request.settlementNonce,
      executedAtSeconds: executedAt,
      ...(bridgeSourceTransaction === null ? {} : { bridgeSourceTxHash: bridgeSourceTransaction }),
      ...(receipt.transactionSignature === null ? {} : { bridgeDestinationTxHash: receipt.transactionSignature }),
      idlePusdUnits: idleAllocation,
      idleUsdcUnits: idleUsdcAllocation,
      orders,
      jupiterSwaps,
    });
    assertLeaseActive(signal);
    const completedSettlement = await this.settlement.completeWithdrawal({
      intent: request.intent,
      navReportHash: pricing.navReportHash,
      executionBatchHash: batch,
      executedAtSeconds: executedAt,
      settlementNonce: request.settlementNonce,
      basketNavValue: pricing.basketNavValue,
      sharePrice: pricing.sharePrice,
      grossRealizedValue: grossRealized,
      protocolFee: fees.protocolFee,
      creatorFee: fees.creatorFee,
      userValueOut: fees.userValueOut,
    });
    await this.faults.after("withdrawal.settlement_submitted", {
      operationId: request.operationId,
      metadata: { transactionSignature: completedSettlement.transactionSignature },
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
      jupiterSwaps: Object.freeze(jupiterSwaps),
      idleUsdcConsumed: idleUsdcAllocation,
      grossRealizedValue: grossRealized,
      protocolFee: fees.protocolFee,
      creatorFee: fees.creatorFee,
      userValueOut: fees.userValueOut,
      bridgeTransaction: receipt.transactionSignature,
      splitTransaction: split.transactionSignature,
      settlementTransaction: completedSettlement.transactionSignature,
    });
  }
}
