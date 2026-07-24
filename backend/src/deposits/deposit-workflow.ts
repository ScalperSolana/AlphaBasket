import { calculateDepositSettlement } from "../accounting/math.js";
import { executionBatchHash, executionRequestHash } from "../execution/hashes.js";
import { allocateDepositPusd, type WeightedExecutionTarget } from "../execution/allocation.js";
import type {
  ExecutionOperation,
  ExecutionOperationStore,
  FakExecutionPort,
  FakOrderResult,
  PolymarketBridgePort,
  PolymarketCreditVerifierPort,
  SolanaFundingVerifierPort,
} from "../execution/types.js";
import type { SignedDepositIntent } from "../quotes/types.js";
import type { FinancialExecutionGuardPort } from "../operations/index.js";
import { NOOP_FAULT_INJECTOR, type FaultInjectorPort } from "../resilience/index.js";
import {
  assertExecutionTimestamp,
  assertFreshSettlementPricing,
  type SettlementPricingPort,
  type SolanaSettlementGatewayPort,
} from "../settlement/types.js";
import type { WalletExecutionCoordinatorPort } from "../wallets/types.js";

const assertLeaseActive = (signal: AbortSignal): void => {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("execution wallet lease was lost");
};

export class BridgePendingError extends Error {
  public constructor(address: string) {
    super(`Polymarket bridge transfer is still pending at ${address}`);
    this.name = "BridgePendingError";
  }
}

export interface PreparedDeposit {
  readonly operation: ExecutionOperation;
  readonly bridgeAddress: string;
}

export interface DepositWorkflowRequest {
  readonly operationId: string;
  readonly requestKey: string;
  readonly workflowId: string;
  readonly intent: SignedDepositIntent;
  readonly polymarketWallet: string;
  readonly walletId: string;
  readonly preparedBridgeAddress: string;
  readonly solanaUsdcMint: string;
  readonly protocolFeeDestination: string;
  readonly fundingTransactionSignature: string;
  readonly maxSlippageBps: number;
  readonly targets: readonly (
    WeightedExecutionTarget & {
      readonly worstBuyPriceUnits: bigint;
      readonly negativeRisk: boolean;
    }
  )[];
  readonly settlementNonce: bigint;
  /** Optional local/staging execution path; hybrid_devnet uses live_bridge. */
  readonly capitalMode?: "prefunded_staging" | "live_bridge";
  /** Runs under the same exclusive wallet lease immediately before external execution. */
  readonly beforeExecution?: () => Promise<void>;
  /** Exactly-once portfolio attribution hook, still under the wallet lease. */
  readonly afterSettlement?: (result: DepositWorkflowResult) => Promise<void>;
  readonly now: Date;
}

export interface DepositWorkflowResult {
  readonly operation: ExecutionOperation;
  readonly executionBatchHash: string;
  readonly orders: readonly FakOrderResult[];
  readonly idlePusdUnits: bigint;
  readonly netDepositValue: bigint;
  readonly sharesCredited: bigint;
  readonly settlementTransaction: string;
}

export class DepositWorkflow {
  public constructor(
    private readonly operations: ExecutionOperationStore,
    private readonly bridge: PolymarketBridgePort,
    private readonly creditVerifier: PolymarketCreditVerifierPort,
    private readonly funding: SolanaFundingVerifierPort,
    private readonly fak: FakExecutionPort,
    private readonly pricing: SettlementPricingPort,
    private readonly settlement: SolanaSettlementGatewayPort,
    private readonly executionGuard: FinancialExecutionGuardPort,
    private readonly walletCoordinator: WalletExecutionCoordinatorPort,
    private readonly faults: FaultInjectorPort = NOOP_FAULT_INJECTOR,
  ) {}

  public async prepare(request: {
    readonly operationId: string;
    readonly requestKey: string;
    readonly workflowId: string;
    readonly intent: SignedDepositIntent;
    readonly polymarketWallet: string;
    readonly now: Date;
  }): Promise<PreparedDeposit> {
    const quote = request.intent.quote;
    const requestHash = executionRequestHash({
      kind: "deposit",
      basket: quote.basket.toBase58(),
      user: quote.user.toBase58(),
      intentHash: request.intent.intentHash.toString("hex"),
      grossAmount: quote.grossAmount,
    });
    const loaded = await this.operations.createOrLoad({
      id: request.operationId,
      requestKey: request.requestKey,
      requestHash,
      kind: "deposit",
      workflowId: request.workflowId,
      basket: quote.basket.toBase58(),
      userAddress: quote.user.toBase58(),
      checkpoint: {},
      createdAt: request.now,
    });
    let operation = loaded.operation;
    let bridgeAddress: string;
    if (operation.state === "created") {
      const address = await this.bridge.createDepositAddress(request.polymarketWallet);
      bridgeAddress = address.svm;
      operation = await this.operations.transition(operation.id, operation.version, "intent_verified", {
        bridgeAddress,
      }, request.now);
      await this.faults.after("deposit.bridge_address_created", {
        operationId: request.operationId,
        metadata: { bridgeAddress },
      });
    } else {
      const storedAddress = operation.checkpoint.bridgeAddress;
      if (typeof storedAddress !== "string" || storedAddress.length === 0) throw new Error("deposit preparation checkpoint is missing the bridge address");
      bridgeAddress = storedAddress;
    }
    return Object.freeze({ operation, bridgeAddress });
  }

  public async execute(request: DepositWorkflowRequest): Promise<DepositWorkflowResult> {
    return this.walletCoordinator.execute(request.walletId, request.operationId, async (signal) => {
      assertLeaseActive(signal);
      await this.executionGuard.authorize({
        operationId: request.operationId,
        basketId: request.intent.quote.basket.toBase58(),
        walletId: request.walletId,
        amountUnits: request.intent.quote.grossAmount,
        now: request.now,
      });
      await request.beforeExecution?.();
      const result = await this.executeLocked(request, signal);
      await request.afterSettlement?.(result);
      return result;
    });
  }

  private async executeLocked(request: DepositWorkflowRequest, signal: AbortSignal): Promise<DepositWorkflowResult> {
    const prepared = await this.prepare({
      operationId: request.operationId,
      requestKey: request.requestKey,
      workflowId: request.workflowId,
      intent: request.intent,
      polymarketWallet: request.polymarketWallet,
      now: request.now,
    });
    if (prepared.bridgeAddress !== request.preparedBridgeAddress) {
      throw new Error("deposit preparation checkpoint does not match the submitted funding request");
    }
    let operation = prepared.operation;
    const quote = request.intent.quote;
    assertLeaseActive(signal);
    await this.funding.verifyFinalizedTransfer({
      signature: request.fundingTransactionSignature,
      expectedUser: quote.user.toBase58(),
      expectedBridgeAddress: prepared.bridgeAddress,
      expectedMint: request.solanaUsdcMint,
      expectedAmountUnits: quote.quotedNetValue,
    });
    await this.funding.verifyFinalizedTransfer({
      signature: request.fundingTransactionSignature,
      expectedUser: quote.user.toBase58(),
      expectedBridgeAddress: request.protocolFeeDestination,
      expectedMint: request.solanaUsdcMint,
      expectedAmountUnits: quote.protocolFee,
    });
    if (operation.state === "intent_verified") {
      operation = await this.operations.transition(operation.id, operation.version, "funding_verified", {
        ...operation.checkpoint,
        fundingSignature: request.fundingTransactionSignature,
      }, request.now);
    }
    if (operation.state === "funding_verified") {
      operation = await this.operations.transition(operation.id, operation.version, "bridge_pending", operation.checkpoint, request.now);
    }
    let credited: bigint;
    let bridgeDestinationTxHash: string;
    let bridgeObservedAtMs: bigint;
    if (request.capitalMode === "prefunded_staging") {
      credited = quote.quotedNetValue;
      bridgeDestinationTxHash = `prefunded:${request.operationId}`;
      const storedObservedAtMs = operation.checkpoint.bridgeObservedAtMs;
      bridgeObservedAtMs = typeof storedObservedAtMs === "string"
        ? BigInt(storedObservedAtMs)
        : BigInt(request.now.getTime());
    } else {
      assertLeaseActive(signal);
      const observations = await this.bridge.getStatus(prepared.bridgeAddress);
      const preparedAtMs = BigInt(prepared.operation.createdAt.getTime());
      const completed = observations.find((item) =>
        item.status === "COMPLETED" &&
        item.inputAmountUnits === quote.quotedNetValue &&
        item.observedAtMs >= preparedAtMs,
      );
      if (completed === undefined) {
        if (observations.some((item) => item.status === "FAILED")) throw new Error("Polymarket deposit bridge failed");
        if (operation.state === "bridge_pending") {
          operation = await this.operations.transition(operation.id, operation.version, "bridge_pending", operation.checkpoint, request.now);
        }
        throw new BridgePendingError(prepared.bridgeAddress);
      }
      if (completed.destinationTxHash === null) throw new Error("completed Polymarket deposit is missing its Polygon destination transaction");
      bridgeDestinationTxHash = completed.destinationTxHash;
      bridgeObservedAtMs = completed.observedAtMs;
      assertLeaseActive(signal);
      const credit = await this.creditVerifier.verifyPusdCredit({
        destinationTransactionHash: completed.destinationTxHash,
        polymarketWallet: request.polymarketWallet,
        expectedMaximumUnits: quote.quotedNetValue,
      });
      credited = credit.amountUnits;
      if (credited <= 0n || credited > quote.quotedNetValue) throw new Error("verified Polymarket pUSD credit is outside the deposit bounds");
    }
    if (operation.state === "bridge_pending") {
      operation = await this.operations.transition(operation.id, operation.version, "bridge_completed", {
        ...operation.checkpoint,
        bridgeDestinationTxHash,
        bridgeObservedAtMs: bridgeObservedAtMs.toString(10),
        creditedPusdUnits: credited.toString(10),
      }, request.now);
    }
    const allocation = allocateDepositPusd(credited, request.targets);
    const orders: FakOrderResult[] = [];
    for (let index = 0; index < allocation.targets.length; index += 1) {
      const target = allocation.targets[index];
      const source = request.targets[index];
      if (target === undefined || source === undefined || target.amountUnits === 0n) continue;
      assertLeaseActive(signal);
      const order = await this.fak.executeFak({
        clientOrderId: `${request.operationId}:buy:${index}`,
        tokenId: target.tokenId,
        side: "buy",
        negativeRisk: source.negativeRisk,
        amountUnits: target.amountUnits,
        worstPriceUnits: source.worstBuyPriceUnits,
      });
      orders.push(order);
      await this.faults.after("deposit.fak_order_executed", {
        operationId: request.operationId,
        metadata: { clientOrderId: order.clientOrderId, orderId: order.orderId },
      });
    }
    const spent = orders.reduce((sum, order) => sum + order.filledInputUnits, 0n);
    if (spent > credited) throw new Error("FAK buys spent more pUSD than the bridge credited");
    const idlePusdUnits = credited - spent;
    if (operation.state === "bridge_completed") {
      operation = await this.operations.transition(operation.id, operation.version, "trading_completed", {
        ...operation.checkpoint,
        idlePusdUnits: idlePusdUnits.toString(10),
        orderIds: orders.map((order) => order.orderId),
      }, request.now);
    }
    assertLeaseActive(signal);
    const nowSeconds = BigInt(Math.floor(request.now.getTime() / 1_000));
    const pricing = await this.pricing.loadLatestPricing(quote.basket);
    assertFreshSettlementPricing(pricing, nowSeconds);
    if (request.maxSlippageBps !== quote.maxSlippageBps) throw new Error("deposit slippage policy differs from the signed quote");
    const math = calculateDepositSettlement(
      quote.grossAmount,
      credited,
      pricing.sharePrice,
      request.maxSlippageBps,
    );
    if (math.minimumNetValue !== quote.minimumNetValue) throw new Error("deposit minimum differs from the signed quote");
    if (math.sharesCredited < quote.minSharesOut) throw new Error("executed deposit credits fewer than the user-authorized minimum shares");
    const executedAt = orders.reduce(
      (latest, order) => order.executedAtMs > latest ? order.executedAtMs : latest,
      bridgeObservedAtMs,
    ) / 1_000n;
    assertExecutionTimestamp(executedAt, nowSeconds);
    const batch = executionBatchHash({
      kind: "deposit",
      operationId: request.operationId,
      basket: quote.basket.toBase58(),
      navReportHash: Buffer.from(pricing.navReportHash).toString("hex"),
      settlementNonce: request.settlementNonce,
      executedAtSeconds: executedAt,
      bridgeSourceTxHash: request.fundingTransactionSignature,
      bridgeDestinationTxHash,
      idlePusdUnits,
      orders,
    });
    assertLeaseActive(signal);
    const result = await this.settlement.completeDeposit({
      intent: request.intent,
      navReportHash: pricing.navReportHash,
      executionBatchHash: batch,
      executedAtSeconds: executedAt,
      settlementNonce: request.settlementNonce,
      basketNavValue: pricing.basketNavValue,
      sharePrice: pricing.sharePrice,
      netDepositValue: credited,
      sharesCredited: math.sharesCredited,
      protocolFee: quote.protocolFee,
    });
    await this.faults.after("deposit.settlement_submitted", {
      operationId: request.operationId,
      metadata: { transactionSignature: result.transactionSignature },
    });
    if (operation.state === "trading_completed") {
      operation = await this.operations.transition(operation.id, operation.version, "settlement_submitted", {
        ...operation.checkpoint,
        executionBatchHash: batch.toString("hex"),
        settlementTransaction: result.transactionSignature,
      }, request.now);
    }
    if (operation.state === "settlement_submitted") {
      operation = await this.operations.transition(operation.id, operation.version, "completed", operation.checkpoint, request.now);
    }
    return Object.freeze({
      operation,
      executionBatchHash: batch.toString("hex"),
      orders: Object.freeze(orders),
      idlePusdUnits,
      netDepositValue: credited,
      sharesCredited: math.sharesCredited,
      settlementTransaction: result.transactionSignature,
    });
  }
}
