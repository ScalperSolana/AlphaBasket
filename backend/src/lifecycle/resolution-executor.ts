import { createHash } from "node:crypto";

import type { PolymarketBalancePort } from "../execution/types.js";
import type { BasketAttributedHoldingsPort } from "../nav/types.js";
import type { JsonValue } from "../persistence/outbox.js";
import type { WalletExecutionCoordinatorPort } from "../wallets/types.js";
import { NOOP_FAULT_INJECTOR, type FaultInjectorPort } from "../resilience/index.js";
import {
  redemptionTransaction,
  type PolymarketPositionsPort,
  type PolymarketRelayerPort,
} from "../polymarket/index.js";
import type {
  ConditionRedemptionRecord,
  ConditionRedemptionResult,
  ConditionRedemptionStorePort,
} from "./condition-redemption-store.js";
import type { LifecycleExternalExecutionStorePort } from "./execution-store.js";
import type { ClockPort, ResolutionExecutionPort, ResolutionExecutionResult } from "./types.js";

function resolutionRequestHash(basketId: string): string {
  return createHash("sha256").update(JSON.stringify(["ALPHABASKET_RESOLUTION_EXECUTION_V1", basketId]), "utf8").digest("hex");
}

function conditionRequestHash(wallet: string, conditionId: string, negativeRisk: boolean): string {
  return createHash("sha256").update(JSON.stringify([
    "ALPHABASKET_CONDITION_REDEMPTION_V1",
    wallet.toLowerCase(),
    conditionId.toLowerCase(),
    negativeRisk,
  ]), "utf8").digest("hex");
}

function resultJson(result: ResolutionExecutionResult): JsonValue {
  return {
    executionHash: result.executionHash,
    finalReportHash: Buffer.from(result.finalReportHash).toString("hex"),
    finalNavValue: result.finalNavValue.toString(10),
    externalReferences: [...result.externalReferences],
    executedAtMs: result.executedAtMs.toString(10),
  };
}

function resultFromJson(value: JsonValue): ResolutionExecutionResult {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("stored resolution result is invalid");
  const record = value as { readonly [key: string]: JsonValue };
  const executionHash = record.executionHash;
  const report = record.finalReportHash;
  const nav = record.finalNavValue;
  const references = record.externalReferences;
  const executedAt = record.executedAtMs;
  if (typeof executionHash !== "string" || !/^[0-9a-f]{64}$/u.test(executionHash) ||
      typeof report !== "string" || !/^[0-9a-f]{64}$/u.test(report) ||
      typeof nav !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(nav) ||
      !Array.isArray(references) || !references.every((item) => typeof item === "string") ||
      typeof executedAt !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(executedAt)) {
    throw new Error("stored resolution result is incomplete");
  }
  return Object.freeze({
    executionHash,
    finalReportHash: Uint8Array.from(Buffer.from(report, "hex")),
    finalNavValue: BigInt(nav),
    externalReferences: Object.freeze(references as string[]),
    executedAtMs: BigInt(executedAt),
  });
}

function completedRedemption(record: Extract<ConditionRedemptionRecord, { readonly state: "completed" }>): ConditionRedemptionResult {
  return Object.freeze({
    walletAddress: record.walletAddress,
    conditionId: record.conditionId,
    negativeRisk: record.negativeRisk,
    winningTokenId: record.winningTokenId,
    walletPayoutUnits: record.walletPayoutUnits,
    relayerTransactionId: record.relayerTransactionId,
    polygonTransactionHash: record.polygonTransactionHash,
  });
}

export class PolymarketResolutionExecutor implements ResolutionExecutionPort {
  private readonly wallet: string;

  public constructor(
    wallet: string,
    private readonly portfolio: BasketAttributedHoldingsPort,
    private readonly executions: LifecycleExternalExecutionStorePort,
    private readonly positions: PolymarketPositionsPort,
    private readonly redemptions: ConditionRedemptionStorePort,
    private readonly relayer: PolymarketRelayerPort,
    private readonly balance: PolymarketBalancePort,
    private readonly clock: ClockPort,
    private readonly walletCoordinator: WalletExecutionCoordinatorPort,
    private readonly faults: FaultInjectorPort = NOOP_FAULT_INJECTOR,
  ) {
    this.wallet = wallet.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/u.test(this.wallet)) throw new TypeError("invalid Polymarket resolution wallet");
  }

  public async resolve(request: {
    readonly operationId: string;
    readonly basket: import("@solana/web3.js").PublicKey;
  }): Promise<ResolutionExecutionResult> {
    return this.walletCoordinator.execute(this.wallet, request.operationId, async (signal) => {
      if (signal.aborted) throw signal.reason;
      return this.resolveLocked(request, signal);
    });
  }

  private async resolveLocked(request: {
    readonly operationId: string;
    readonly basket: import("@solana/web3.js").PublicKey;
  }, signal: AbortSignal): Promise<ResolutionExecutionResult> {
    const basketId = request.basket.toBase58();
    const hash = resolutionRequestHash(basketId);
    const replay = await this.executions.prepare({
      operationId: request.operationId,
      requestHash: hash,
      kind: "resolution",
      basketId,
      now: this.clock.now(),
    });
    if (replay !== null) return resultFromJson(replay);
    const state = await this.portfolio.loadBasketState(basketId);
    const conditions = new Map<string, boolean>();
    for (const holding of state.holdings) {
      if (holding.quantityUnits === 0n) continue;
      if (holding.conditionId === undefined || holding.negativeRisk === undefined) {
        throw new Error(`holding ${holding.tokenId} is missing resolution metadata; backfill condition IDs before resolution`);
      }
      const existing = conditions.get(holding.conditionId);
      if (existing !== undefined && existing !== holding.negativeRisk) throw new Error("basket condition has conflicting negative-risk metadata");
      conditions.set(holding.conditionId, holding.negativeRisk);
    }
    const existingRecords = new Map<string, ConditionRedemptionRecord | null>();
    for (const conditionId of conditions.keys()) {
      existingRecords.set(conditionId, await this.redemptions.load({ walletAddress: this.wallet, conditionId }));
    }
    const walletPositions = [...existingRecords.values()].some((record) => record === null)
      ? await this.positions.listRedeemable(this.wallet)
      : [];
    if (signal.aborted) throw signal.reason;
    const resolved = new Map<string, ConditionRedemptionResult>();

    for (const [conditionId, negativeRisk] of [...conditions.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
      const conditionHash = conditionRequestHash(this.wallet, conditionId, negativeRisk);
      let record = existingRecords.get(conditionId) ?? null;
      if (record === null) {
        if (signal.aborted) throw signal.reason;
        const matching = walletPositions.filter((position) => position.conditionId === conditionId);
        if (matching.length === 0) throw new Error(`Polymarket wallet has no redeemable position for condition ${conditionId}`);
        if (matching.some((position) => position.negativeRisk !== negativeRisk)) throw new Error("Polymarket position negative-risk metadata mismatch");
        const winners = matching.filter((position) => position.currentPriceUnits === 1_000_000n);
        if (winners.length !== 1) throw new Error(`resolved condition ${conditionId} does not have exactly one winning token`);
        const winning = winners[0];
        if (winning === undefined) throw new Error("unreachable missing winning position");
        const walletBalanceBeforeUnits = await this.balance.getPusdBalanceUnits(this.wallet);
        record = await this.redemptions.prepare({
          walletAddress: this.wallet,
          conditionId,
          requestHash: conditionHash,
          negativeRisk,
          winningTokenId: winning.tokenId,
          walletPayoutUnits: winning.sizeUnits,
          walletBalanceBeforeUnits,
          now: this.clock.now(),
        });
      }
      if (record.requestHash !== conditionHash || record.negativeRisk !== negativeRisk) {
        throw new Error("stored condition redemption does not match the resolution request");
      }
      let redemption: ConditionRedemptionResult;
      if (record.state === "completed") {
        redemption = completedRedemption(record);
      } else {
        if (signal.aborted) throw signal.reason;
        const relayed = await this.relayer.execute({
          operationId: `condition-redemption:${this.wallet}:${conditionId}`,
          proxyWallet: this.wallet,
          transactions: [redemptionTransaction(conditionId, negativeRisk)],
          description: `AlphaBasket redeem ${conditionId}`,
        });
        await this.faults.after("resolution.condition_redeemed", {
          operationId: request.operationId,
          metadata: { conditionId, transactionId: relayed.transactionId },
        });
        if (signal.aborted) throw signal.reason;
        const balanceAfter = await this.balance.getPusdBalanceUnits(this.wallet);
        if (balanceAfter < record.walletBalanceBeforeUnits + record.walletPayoutUnits) {
          throw new Error("verified pUSD balance is below the prepared redemption floor");
        }
        redemption = await this.redemptions.complete({
          walletAddress: this.wallet,
          conditionId,
          requestHash: conditionHash,
          negativeRisk,
          winningTokenId: record.winningTokenId,
          walletPayoutUnits: record.walletPayoutUnits,
          relayerTransactionId: relayed.transactionId,
          polygonTransactionHash: relayed.transactionHash,
          now: this.clock.now(),
        });
      }
      resolved.set(conditionId, redemption);
    }

    let finalNavValue = state.idlePusdUnits;
    for (const holding of state.holdings) {
      if (holding.quantityUnits === 0n) continue;
      const conditionId = holding.conditionId;
      if (conditionId === undefined) throw new Error("holding condition metadata disappeared during resolution");
      const redemption = resolved.get(conditionId);
      if (redemption === undefined) throw new Error(`missing condition redemption for ${conditionId}`);
      if (redemption.winningTokenId === holding.tokenId) finalNavValue += holding.quantityUnits;
    }
    const reportHash = createHash("sha256").update(JSON.stringify([
      "ALPHABASKET_FINAL_NAV_REPORT_V1",
      basketId,
      state.ledgerVersion,
      state.compositionVersion.toString(10),
      state.compositionHash,
      finalNavValue.toString(10),
      [...resolved.values()].sort((left, right) => left.conditionId.localeCompare(right.conditionId, "en")).map((item) => [
        item.conditionId,
        item.winningTokenId,
        item.polygonTransactionHash,
      ]),
    ]), "utf8").digest();
    const executionHash = createHash("sha256").update(Buffer.concat([
      Buffer.from("ALPHABASKET_RESOLUTION_RESULT_V1", "ascii"),
      reportHash,
    ])).digest("hex");
    const result: ResolutionExecutionResult = Object.freeze({
      executionHash,
      finalReportHash: Uint8Array.from(reportHash),
      finalNavValue,
      externalReferences: Object.freeze([...resolved.values()].flatMap((item) => [item.relayerTransactionId, item.polygonTransactionHash])),
      executedAtMs: BigInt(this.clock.now().getTime()),
    });
    if (signal.aborted) throw signal.reason;
    const committed = await this.executions.commit({
      operationId: request.operationId,
      requestHash: hash,
      basketId,
      expectedLedgerVersion: state.ledgerVersion,
      nextCompositionVersion: state.compositionVersion,
      nextCompositionHash: state.compositionHash,
      idlePusdUnits: finalNavValue,
      holdings: [],
      result: resultJson(result),
      now: this.clock.now(),
    });
    return resultFromJson(committed);
  }
}
