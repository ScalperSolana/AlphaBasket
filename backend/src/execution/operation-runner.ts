import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import type { DepositWorkflow, DepositWorkflowResult } from "../deposits/index.js";
import type { BasketAttributedHolding } from "../nav/index.js";
import type { SqlClient, SqlExecutor } from "../persistence/index.js";
import {
  PRICE_SCALE,
  type ClobMarketDataPort,
  type OrderBook,
} from "../polymarket/index.js";
import type { PolymarketBalancePort } from "./types.js";
import { derivePositionPda } from "../contract/index.js";
import type { WithdrawalWorkflow, WithdrawalWorkflowResult } from "../withdrawals/index.js";
import type {
  ExecutionOperationRunnerPort,
  ExecutionWorkRequest,
} from "./work-queue.js";

const integerText = z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u);
const indexedInteger = z.union([
  integerText,
  z.number().int().safe().transform((value) => value.toString(10)),
]);
const publicKey = z.string().transform((value, context) => {
  try {
    return new PublicKey(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid indexed Solana public key" });
    return z.NEVER;
  }
});
const predictionMarket = z.object({
  outcome: indexedInteger,
  ctfTokenId: z.string().regex(/^[0-9a-f]{64}$/u),
}).passthrough();
const basketAsset = z.object({
  marketId: z.string().min(1).max(64),
  kind: z.object({ predictionMarket }).passthrough(),
  weightBps: indexedInteger,
}).passthrough();
const basketAccount = z.object({
  status: z.unknown(),
  compositionVersion: indexedInteger,
  totalSharesOutstanding: integerText,
  lastSettlementNonce: integerText,
  performanceFeeBps: indexedInteger,
  creatorFeeDestination: publicKey,
  protocolFeeDestination: publicKey,
  items: z.array(basketAsset).min(1).max(16),
}).passthrough();
const configAccount = z.object({
  settlementMint: publicKey,
  maxSlippageBps: indexedInteger,
}).passthrough();
const positionAccount = z.object({
  sharesOwned: integerText,
  costBasisValue: integerText,
  weightedDepositTimestamp: integerText,
}).passthrough();

interface ProjectionRow extends Record<string, unknown> {
  account_data: unknown;
}

interface PortfolioRow extends Record<string, unknown> {
  ledger_version: string;
  composition_version: string;
  idle_pusd_units: string;
}

interface HoldingRow extends Record<string, unknown> {
  market_id: string;
  token_id: string;
  condition_id: string | null;
  outcome: string;
  quantity_units: string;
  mark_price_units: string;
  price_scale: string;
  mark_observed_at_ms: string;
  mark_source_hash: string;
  mark_condition: BasketAttributedHolding["markCondition"];
}

interface SupplyRow extends Record<string, unknown> {
  total_shares_units: string;
}

function activeStatus(value: unknown): boolean {
  return value === "active" ||
    (typeof value === "object" && value !== null && Object.hasOwn(value, "active"));
}

function ctfTokenId(hex: string): string {
  const value = BigInt(`0x${hex}`);
  if (value <= 0n) throw new TypeError("indexed CTF token ID must be non-zero");
  return value.toString(10);
}

function numeric(value: string, field: string): bigint {
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`database returned invalid ${field}`);
  return BigInt(value);
}

export interface ExecutionTargetState {
  readonly marketId: string;
  readonly conditionId: string | null;
  readonly tokenId: string;
  readonly outcome: string;
  readonly outcomeIndex: number;
  readonly weightBps: number;
  readonly currentUnits: bigint;
}

export interface FinancialExecutionContext {
  readonly basket: PublicKey;
  readonly compositionVersion: number;
  readonly totalSharesOutstanding: bigint;
  readonly lastSettlementNonce: bigint;
  readonly performanceFeeBps: number;
  readonly creatorFeeDestination: PublicKey;
  readonly protocolFeeDestination: PublicKey;
  readonly settlementMint: PublicKey;
  readonly maximumSlippageBps: number;
  readonly positionSharesOwned: bigint;
  readonly positionCostBasisValue: bigint;
  readonly weightedDepositTimestamp: bigint;
  readonly ledgerVersion: string;
  readonly idlePusdUnits: bigint;
  readonly targets: readonly ExecutionTargetState[];
}

export interface FinancialExecutionContextPort {
  load(basket: PublicKey, user: PublicKey): Promise<FinancialExecutionContext>;
}

export class PostgresFinancialExecutionContext implements FinancialExecutionContextPort {
  public constructor(
    private readonly sql: SqlClient,
    private readonly programId: PublicKey,
  ) {}

  public async load(basket: PublicKey, user: PublicKey): Promise<FinancialExecutionContext> {
    return this.sql.transaction(async (transaction) => {
      const [basketResult, configResult, portfolioResult, holdingsResult, supplyResult] = await Promise.all([
        transaction.query<ProjectionRow>(
          `SELECT account_data FROM solana_account_projections
           WHERE address = $1 AND account_kind = 'Basket' AND is_active = true`,
          [basket.toBase58()],
        ),
        transaction.query<ProjectionRow>(
          `SELECT account_data FROM solana_account_projections
           WHERE owner = $1 AND account_kind = 'Config' AND is_active = true
           ORDER BY source_slot DESC LIMIT 2`,
          [this.programId.toBase58()],
        ),
        transaction.query<PortfolioRow>(
          `SELECT ledger_version, composition_version::text AS composition_version,
                  idle_pusd_units::text AS idle_pusd_units
           FROM basket_portfolio_states WHERE basket_id = $1 FOR SHARE`,
          [basket.toBase58()],
        ),
        transaction.query<HoldingRow>(
          `SELECT market_id, token_id, condition_id, outcome,
                  quantity_units::text AS quantity_units,
                  mark_price_units::text AS mark_price_units,
                  price_scale::text AS price_scale,
                  mark_observed_at_ms::text AS mark_observed_at_ms,
                  mark_source_hash, mark_condition
           FROM basket_holding_projections
           WHERE basket_id = $1 ORDER BY market_id, token_id, outcome`,
          [basket.toBase58()],
        ),
        transaction.query<SupplyRow>(
          `SELECT total_shares_units::text AS total_shares_units
           FROM basket_share_supply_projections WHERE basket_id = $1`,
          [basket.toBase58()],
        ),
      ]);
      const basketRow = basketResult.rows[0];
      const configRow = configResult.rows[0];
      const portfolio = portfolioResult.rows[0];
      const supply = supplyResult.rows[0];
      if (basketRow === undefined || configResult.rows.length !== 1 || configRow === undefined) {
        throw new Error("finalized Solana basket/config projection is unavailable");
      }
      if (portfolio === undefined || supply === undefined) {
        throw new Error("basket portfolio/share-supply projection is unavailable");
      }
      const decodedBasket = basketAccount.parse(basketRow.account_data);
      const decodedConfig = configAccount.parse(configRow.account_data);
      if (!activeStatus(decodedBasket.status)) throw new Error("basket is not active");
      const compositionVersion = Number(BigInt(decodedBasket.compositionVersion));
      const portfolioCompositionVersion = numeric(portfolio.composition_version, "portfolio composition version");
      if (portfolioCompositionVersion !== BigInt(compositionVersion)) {
        throw new Error("portfolio composition is behind the finalized Solana basket");
      }
      const holdingByToken = new Map(holdingsResult.rows.map((holding) => [holding.token_id, holding]));
      const targets = decodedBasket.items.map((item): ExecutionTargetState => {
        const tokenId = ctfTokenId(item.kind.predictionMarket.ctfTokenId);
        const holding = holdingByToken.get(tokenId);
        if (holding === undefined || holding.market_id !== item.marketId) {
          throw new Error(`portfolio holding is missing for basket token ${tokenId}`);
        }
        const weightBps = Number(BigInt(item.weightBps));
        const outcomeIndex = Number(BigInt(item.kind.predictionMarket.outcome));
        if (
          !Number.isSafeInteger(weightBps) ||
          weightBps <= 0 ||
          weightBps > 4_000 ||
          (outcomeIndex !== 0 && outcomeIndex !== 1)
        ) {
          throw new TypeError("indexed basket target is invalid");
        }
        return Object.freeze({
          marketId: item.marketId,
          conditionId: holding.condition_id,
          tokenId,
          outcome: holding.outcome,
          outcomeIndex,
          weightBps,
          currentUnits: numeric(holding.quantity_units, "holding quantity"),
        });
      });
      if (targets.reduce((sum, target) => sum + target.weightBps, 0) !== 10_000) {
        throw new TypeError("indexed basket weights do not total 10,000 bps");
      }
      const [positionAddress] = derivePositionPda(basket, user, this.programId);
      const positionResult = await transaction.query<ProjectionRow>(
        `SELECT account_data FROM solana_account_projections
         WHERE address = $1 AND account_kind = 'Position' AND is_active = true`,
        [positionAddress.toBase58()],
      );
      const position = positionResult.rows[0] === undefined
        ? { sharesOwned: "0", costBasisValue: "0", weightedDepositTimestamp: "0" }
        : positionAccount.parse(positionResult.rows[0].account_data);
      const performanceFeeBps = Number(BigInt(decodedBasket.performanceFeeBps));
      const maximumSlippageBps = Number(BigInt(decodedConfig.maxSlippageBps));
      if (
        !Number.isSafeInteger(performanceFeeBps) ||
        performanceFeeBps < 0 ||
        performanceFeeBps > 2_000 ||
        !Number.isSafeInteger(maximumSlippageBps) ||
        maximumSlippageBps < 0 ||
        maximumSlippageBps > 10_000
      ) {
        throw new TypeError("indexed execution fee/slippage policy is invalid");
      }
      return Object.freeze({
        basket,
        compositionVersion,
        totalSharesOutstanding: numeric(supply.total_shares_units, "projected total shares"),
        lastSettlementNonce: BigInt(decodedBasket.lastSettlementNonce),
        performanceFeeBps,
        creatorFeeDestination: decodedBasket.creatorFeeDestination,
        protocolFeeDestination: decodedBasket.protocolFeeDestination,
        settlementMint: decodedConfig.settlementMint,
        maximumSlippageBps,
        positionSharesOwned: BigInt(position.sharesOwned),
        positionCostBasisValue: BigInt(position.costBasisValue),
        weightedDepositTimestamp: BigInt(position.weightedDepositTimestamp),
        ledgerVersion: portfolio.ledger_version,
        idlePusdUnits: numeric(portfolio.idle_pusd_units, "idle pUSD"),
        targets: Object.freeze(targets),
      });
    }, { isolation: "repeatable read", readOnly: true });
  }
}

export interface ExecutionPortfolioCommitPort {
  attributedIdlePusd(walletId: string): Promise<bigint>;
  commitDeposit(request: {
    readonly operationId: string;
    readonly basketId: string;
    readonly expectedLedgerVersion: string;
    readonly result: DepositWorkflowResult;
    readonly now: Date;
  }): Promise<void>;
  commitWithdrawal(request: {
    readonly operationId: string;
    readonly basketId: string;
    readonly expectedLedgerVersion: string;
    readonly idlePusdConsumed: bigint;
    readonly result: WithdrawalWorkflowResult;
    readonly now: Date;
  }): Promise<void>;
}

interface CommitRow extends Record<string, unknown> {
  execution_batch_hash: string;
}

export class PostgresExecutionPortfolioCommit implements ExecutionPortfolioCommitPort {
  public constructor(private readonly sql: SqlClient) {}

  public async attributedIdlePusd(walletId: string): Promise<bigint> {
    const result = await this.sql.query<{ total: string }>(
      `SELECT COALESCE(sum(portfolio.idle_pusd_units), 0)::text AS total
       FROM wallet_assignments assignment
       JOIN basket_portfolio_states portfolio
         ON portfolio.basket_id = assignment.basket_id
       WHERE assignment.wallet_id = $1`,
      [walletId],
    );
    return numeric(result.rows[0]?.total ?? "0", "wallet attributed idle pUSD");
  }

  public async commitDeposit(request: {
    readonly operationId: string;
    readonly basketId: string;
    readonly expectedLedgerVersion: string;
    readonly result: DepositWorkflowResult;
    readonly now: Date;
  }): Promise<void> {
    await this.commit(
      request.operationId,
      request.basketId,
      request.expectedLedgerVersion,
      request.result.executionBatchHash,
      request.now,
      request.result.idlePusdUnits,
      request.result.orders.map((order) => Object.freeze({
        tokenId: order.tokenId,
        quantityDelta: order.filledOutputUnits,
      })),
    );
  }

  public async commitWithdrawal(request: {
    readonly operationId: string;
    readonly basketId: string;
    readonly expectedLedgerVersion: string;
    readonly idlePusdConsumed: bigint;
    readonly result: WithdrawalWorkflowResult;
    readonly now: Date;
  }): Promise<void> {
    await this.commit(
      request.operationId,
      request.basketId,
      request.expectedLedgerVersion,
      request.result.executionBatchHash,
      request.now,
      -request.idlePusdConsumed,
      request.result.orders.map((order) => Object.freeze({
        tokenId: order.tokenId,
        quantityDelta: -order.filledInputUnits,
      })),
    );
  }

  private async commit(
    operationId: string,
    basketId: string,
    expectedLedgerVersion: string,
    executionBatchHash: string,
    now: Date,
    idleDelta: bigint,
    holdingDeltas: readonly Readonly<{ tokenId: string; quantityDelta: bigint }>[],
  ): Promise<void> {
    await this.sql.transaction(async (transaction) => {
      const priorCommit = await transaction.query<CommitRow>(
        `SELECT execution_batch_hash FROM portfolio_execution_commits
         WHERE operation_id = $1::uuid`,
        [operationId],
      );
      const replay = priorCommit.rows[0];
      if (replay !== undefined) {
        if (replay.execution_batch_hash !== executionBatchHash) {
          throw new Error("operation replay produced a different execution batch");
        }
        return;
      }
      const state = await transaction.query<{ ledger_version: string; idle_pusd_units: string }>(
        `SELECT ledger_version, idle_pusd_units::text AS idle_pusd_units
         FROM basket_portfolio_states WHERE basket_id = $1 FOR UPDATE`,
        [basketId],
      );
      const current = state.rows[0];
      if (current === undefined || current.ledger_version !== expectedLedgerVersion) {
        throw new Error("basket portfolio changed during external execution");
      }
      const nextIdle = numeric(current.idle_pusd_units, "idle pUSD") + idleDelta;
      if (nextIdle < 0n) throw new Error("portfolio commit would make idle pUSD negative");
      for (const delta of holdingDeltas) {
        const updated = await transaction.query(
          `UPDATE basket_holding_projections
           SET quantity_units = quantity_units + $3::numeric, updated_at = $4
           WHERE basket_id = $1 AND token_id = $2
             AND quantity_units + $3::numeric >= 0`,
          [basketId, delta.tokenId, delta.quantityDelta.toString(10), now],
        );
        if (updated.rowCount !== 1) {
          throw new Error(`portfolio commit cannot apply token delta for ${delta.tokenId}`);
        }
      }
      const nextVersion = `execution:${operationId}:${executionBatchHash}`;
      await transaction.query(
        `UPDATE basket_portfolio_states
         SET ledger_version = $2, idle_pusd_units = $3::numeric, updated_at = $4
         WHERE basket_id = $1`,
        [basketId, nextVersion, nextIdle.toString(10), now],
      );
      await transaction.query(
        `INSERT INTO portfolio_execution_commits (
           operation_id, execution_batch_hash, basket_id,
           ledger_version_before, ledger_version_after, committed_at
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
        [operationId, executionBatchHash, basketId, expectedLedgerVersion, nextVersion, now],
      );
    }, { isolation: "serializable", maxSerializationRetries: 3 });
  }
}

function buyBound(book: OrderBook, slippageBps: number): bigint {
  const bestAsk = book.asks[0]?.priceUnits;
  if (bestAsk === undefined) throw new Error(`Polymarket book ${book.tokenId} has no executable ask`);
  const adjusted = (bestAsk * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
  return adjusted >= PRICE_SCALE ? PRICE_SCALE - 1n : adjusted;
}

function sellBound(book: OrderBook, slippageBps: number): bigint {
  const bestBid = book.bids[0]?.priceUnits;
  if (bestBid === undefined) throw new Error(`Polymarket book ${book.tokenId} has no executable bid`);
  const adjusted = (bestBid * BigInt(10_000 - slippageBps)) / 10_000n;
  return adjusted > 0n ? adjusted : 1n;
}

function executionContextFingerprint(context: FinancialExecutionContext): string {
  return JSON.stringify([
    context.basket.toBase58(),
    context.compositionVersion,
    context.totalSharesOutstanding.toString(10),
    context.lastSettlementNonce.toString(10),
    context.performanceFeeBps,
    context.creatorFeeDestination.toBase58(),
    context.protocolFeeDestination.toBase58(),
    context.settlementMint.toBase58(),
    context.maximumSlippageBps,
    context.positionSharesOwned.toString(10),
    context.positionCostBasisValue.toString(10),
    context.weightedDepositTimestamp.toString(10),
    context.ledgerVersion,
    context.idlePusdUnits.toString(10),
    context.targets.map((target) => [
      target.marketId,
      target.conditionId,
      target.tokenId,
      target.outcome,
      target.outcomeIndex,
      target.weightBps,
      target.currentUnits.toString(10),
    ]),
  ]);
}

export interface FinancialExecutionRunnerOptions {
  readonly capitalMode: "prefunded_staging" | "live_bridge";
  readonly solanaSettlementReceiver: string;
  readonly polymarketSolanaChainId: string;
  readonly capitalUsdcMint: string;
}

export class FinancialExecutionOperationRunner implements ExecutionOperationRunnerPort {
  public constructor(
    private readonly contexts: FinancialExecutionContextPort,
    private readonly portfolios: ExecutionPortfolioCommitPort,
    private readonly clob: ClobMarketDataPort,
    private readonly deposit: DepositWorkflow,
    private readonly withdrawal: WithdrawalWorkflow,
    private readonly pusdBalance: PolymarketBalancePort | null,
    private readonly options: FinancialExecutionRunnerOptions,
  ) {}

  public async run(request: ExecutionWorkRequest): Promise<Readonly<{
    operationId: string;
    kind: "deposit" | "withdrawal";
    executionBatchHash: string;
    settlementTransaction: string;
  }>> {
    const quote = request.intent.quote;
    const context = await this.contexts.load(quote.basket, quote.user);
    if (context.settlementMint.toBase58() !== this.options.capitalUsdcMint) {
      throw new Error("basket settlement mint does not match the configured capital Solana USDC mint");
    }
    if (context.compositionVersion !== quote.compositionVersion) {
      throw new Error("basket composition changed after the user signed the intent");
    }
    if (quote.maxSlippageBps > context.maximumSlippageBps) {
      throw new Error("signed slippage exceeds the current on-chain policy");
    }
    const books = await Promise.all(context.targets.map(async (target) => {
      const book = await this.clob.getOrderBook(target.tokenId);
      if (book.tokenId !== target.tokenId) throw new Error("CLOB returned a different token");
      if (
        target.conditionId !== null &&
        book.marketId.toLowerCase() !== target.conditionId.toLowerCase()
      ) {
        throw new Error("CLOB book condition differs from the attributed holding");
      }
      return book;
    }));
    const now = new Date();
    const assertFreshContext = async (): Promise<void> => {
      const refreshed = await this.contexts.load(quote.basket, quote.user);
      if (executionContextFingerprint(refreshed) !== executionContextFingerprint(context)) {
        throw new Error("basket execution context changed before the wallet lease was acquired");
      }
    };
    if (request.kind === "deposit" && request.intent.kind === "deposit") {
      const depositQuote = request.intent.quote;
      if (request.fundingAddress === null || request.fundingTransactionSignature === null) {
        throw new Error("deposit execution request is not funded");
      }
      const result = await this.deposit.execute({
        operationId: request.operationId,
        requestKey: request.requestKey,
        workflowId: request.workflowId,
        intent: request.intent,
        polymarketWallet: request.polymarketWallet,
        walletId: request.walletId,
        preparedBridgeAddress: request.fundingAddress,
        solanaUsdcMint: context.settlementMint.toBase58(),
        protocolFeeDestination: context.protocolFeeDestination.toBase58(),
        fundingTransactionSignature: request.fundingTransactionSignature,
        maxSlippageBps: quote.maxSlippageBps,
        targets: context.targets.map((target, index) => Object.freeze({
          tokenId: target.tokenId,
          weightBps: target.weightBps,
          worstBuyPriceUnits: buyBound(books[index] as OrderBook, quote.maxSlippageBps),
          negativeRisk: (books[index] as OrderBook).negativeRisk,
        })),
        settlementNonce: context.lastSettlementNonce + 1n,
        capitalMode: this.options.capitalMode,
        beforeExecution: async () => {
          await assertFreshContext();
          if (this.options.capitalMode === "prefunded_staging") {
            if (this.pusdBalance === null) {
              throw new Error("prefunded staging requires Polygon pUSD balance verification");
            }
            const [actualBalance, attributedIdle] = await Promise.all([
              this.pusdBalance.getPusdBalanceUnits(request.polymarketWallet),
              this.portfolios.attributedIdlePusd(request.walletId),
            ]);
            if (actualBalance < attributedIdle + depositQuote.quotedNetValue) {
              throw new Error("prefunded Polygon wallet has insufficient unattributed pUSD");
            }
          }
        },
        afterSettlement: async (settled) => {
          await this.portfolios.commitDeposit({
            operationId: request.operationId,
            basketId: quote.basket.toBase58(),
            expectedLedgerVersion: context.ledgerVersion,
            result: settled,
            now: new Date(),
          });
        },
        now,
      });
      return Object.freeze({
        operationId: request.operationId,
        kind: request.kind,
        executionBatchHash: result.executionBatchHash,
        settlementTransaction: result.settlementTransaction,
      });
    }
    if (request.kind === "withdrawal" && request.intent.kind === "withdrawal") {
      const withdrawalQuote = request.intent.quote;
      if (
        context.totalSharesOutstanding <= 0n ||
        request.intent.quote.shareAmount > context.positionSharesOwned
      ) {
        throw new Error("withdrawal position/supply is no longer sufficient");
      }
      const idlePusdConsumed =
        (context.idlePusdUnits * withdrawalQuote.shareAmount) / context.totalSharesOutstanding;
      const result = await this.withdrawal.execute({
        operationId: request.operationId,
        requestKey: request.requestKey,
        workflowId: request.workflowId,
        intent: request.intent,
        polymarketWallet: request.polymarketWallet,
        walletId: request.walletId,
        totalSharesOutstanding: context.totalSharesOutstanding,
        positionSharesOwned: context.positionSharesOwned,
        positionCostBasisValue: context.positionCostBasisValue,
        weightedDepositTimestamp: context.weightedDepositTimestamp,
        idlePusdUnits: context.idlePusdUnits,
        targets: context.targets.map((target, index) => Object.freeze({
          tokenId: target.tokenId,
          weightBps: target.weightBps,
          currentUnits: target.currentUnits,
          worstSellPriceUnits: sellBound(books[index] as OrderBook, quote.maxSlippageBps),
          negativeRisk: (books[index] as OrderBook).negativeRisk,
        })),
        performanceFeeBps: context.performanceFeeBps,
        maxSlippageBps: quote.maxSlippageBps,
        creatorDestination: context.creatorFeeDestination.toBase58(),
        protocolDestination: context.protocolFeeDestination.toBase58(),
        solanaSettlementReceiver: this.options.solanaSettlementReceiver,
        solanaUsdcMint: context.settlementMint.toBase58(),
        solanaChainId: this.options.polymarketSolanaChainId,
        settlementNonce: context.lastSettlementNonce + 1n,
        capitalMode: this.options.capitalMode,
        beforeExecution: assertFreshContext,
        afterSettlement: async (settled) => {
          await this.portfolios.commitWithdrawal({
            operationId: request.operationId,
            basketId: quote.basket.toBase58(),
            expectedLedgerVersion: context.ledgerVersion,
            idlePusdConsumed,
            result: settled,
            now: new Date(),
          });
        },
        now,
      });
      return Object.freeze({
        operationId: request.operationId,
        kind: request.kind,
        executionBatchHash: result.executionBatchHash,
        settlementTransaction: result.settlementTransaction,
      });
    }
    throw new TypeError("execution work kind and signed intent kind differ");
  }
}
