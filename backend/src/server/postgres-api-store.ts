import { randomUUID } from "node:crypto";

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { NAV_SHARE_PRICE_SCALE } from "../nav/index.js";
import type { SqlClient, SqlExecutor } from "../persistence/index.js";
import type {
  DepositQuote,
  SignedDepositIntent,
  SignedWithdrawalIntent,
  WithdrawalQuote,
} from "../quotes/index.js";
import { derivePositionPda } from "../contract/index.js";
import { ApiRequestError } from "./api-types.js";
import {
  serializeFinancialQuote,
  type ExecutionWalletRoute,
  type FinancialRequestStorePort,
  type PersistedApiOperation,
  type QuoteContext,
  type QuoteContextPort,
} from "./application-service.js";

const integerText = z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u);
const indexedInteger = z.union([
  integerText,
  z.number().int().safe().transform((value) => value.toString(10)),
]);
const publicKeyText = z.string().transform((value, context) => {
  try {
    return new PublicKey(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid indexed public key" });
    return z.NEVER;
  }
});
const basketAccountSchema = z.object({
  compositionVersion: indexedInteger,
  performanceFeeBps: indexedInteger,
  protocolFeeDestination: publicKeyText,
  hasInitializedSharePrice: z.boolean(),
  totalSharesOutstanding: integerText,
  status: z.unknown(),
  items: z.array(z.object({
    weightBps: indexedInteger,
    kind: z.union([
      z.object({ predictionMarket: z.unknown() }).passthrough(),
      z.object({ spot: z.unknown() }).passthrough(),
    ]),
  }).passthrough()).min(1).max(16),
}).passthrough();
const configAccountSchema = z.object({
  maxSlippageBps: indexedInteger,
  settlementMint: publicKeyText,
}).passthrough();
const positionAccountSchema = z.object({
  sharesOwned: integerText,
  costBasisValue: integerText,
  weightedDepositTimestamp: integerText,
}).passthrough();
const navSnapshotSchema = z.object({
  grossNavPusdUnits: integerText,
  sharePriceUnits: integerText.nullable(),
}).passthrough();

interface AccountProjectionRow extends Record<string, unknown> {
  account_data: unknown;
}

interface NavRow extends Record<string, unknown> {
  snapshot_hash: string;
  observed_at_ms: string;
  snapshot: unknown;
}

interface OperationRow extends Record<string, unknown> {
  id: string;
  kind: "deposit" | "withdrawal" | "protocol_fee_withdrawal";
  state: PersistedApiOperation["state"];
  workflow_id: string;
  work_state: PersistedApiOperation["workState"];
  basket: string;
  user_address: string | null;
  wallet_id: string;
  funding_address: string | null;
  funding_transaction_signature: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface IdentityRow extends Record<string, unknown> {
  id: string;
  request_hash: string;
  kind: OperationRow["kind"];
}

interface PortfolioIdentityRow extends Record<string, unknown> {
  composition_hash: string;
  composition_version: string;
}

const operationColumns = `o.id::text AS id, o.kind, o.state, o.workflow_id,
  w.state AS work_state, o.basket, o.user_address, w.wallet_id,
  w.funding_address, w.funding_transaction_signature,
  COALESCE(w.last_error, o.last_error) AS last_error,
  o.created_at, GREATEST(o.updated_at, w.updated_at) AS updated_at`;

function mapOperation(row: OperationRow): PersistedApiOperation {
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    state: row.state,
    workflowId: row.workflow_id,
    workState: row.work_state,
    basket: row.basket,
    userAddress: row.user_address,
    walletId: row.wallet_id,
    fundingAddress: row.funding_address,
    fundingTransactionSignature: row.funding_transaction_signature,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function statusIsActive(value: unknown): boolean {
  if (value === "active") return true;
  return typeof value === "object" && value !== null && Object.hasOwn(value, "active");
}

export class PostgresQuoteContextStore implements QuoteContextPort {
  public constructor(
    private readonly sql: SqlClient,
    private readonly programId: PublicKey,
    private readonly maxNavAgeMs: bigint,
    private readonly nowMs: () => bigint = () => BigInt(Date.now()),
  ) {
    if (maxNavAgeMs <= 0n) throw new RangeError("maximum NAV age must be positive");
  }

  public async loadLatest(basket: PublicKey, user: PublicKey): Promise<QuoteContext> {
    return this.load(basket, user, null);
  }

  public async loadForReport(
    basket: PublicKey,
    user: PublicKey,
    navReportHash: Uint8Array,
  ): Promise<QuoteContext> {
    if (navReportHash.byteLength !== 32) throw new ApiRequestError(400, "invalid_nav_hash", "NAV report hash must contain 32 bytes");
    return this.load(basket, user, Buffer.from(navReportHash).toString("hex"));
  }

  private async load(
    basket: PublicKey,
    user: PublicKey,
    reportHash: string | null,
  ): Promise<QuoteContext> {
    return this.sql.transaction(async (transaction) => {
      const [basketAccount, configAccount, nav, position] = await Promise.all([
        this.loadAccount(transaction, basket.toBase58(), "Basket", basketAccountSchema),
        this.loadSingletonAccount(transaction, "Config", configAccountSchema),
        this.loadNav(transaction, basket.toBase58(), reportHash),
        this.loadPosition(transaction, basket, user),
      ]);
      if (!statusIsActive(basketAccount.status)) {
        throw new ApiRequestError(422, "basket_not_active", "basket is not accepting active deposits or withdrawals");
      }
      const compositionVersion = Number(BigInt(basketAccount.compositionVersion));
      if (!Number.isSafeInteger(compositionVersion) || compositionVersion <= 0 || compositionVersion > 0xffff_ffff) {
        throw new TypeError("indexed basket composition version is invalid");
      }
      const performanceFeeBps = Number(BigInt(basketAccount.performanceFeeBps));
      const maximumSlippageBps = Number(BigInt(configAccount.maxSlippageBps));
      if (
        !Number.isSafeInteger(performanceFeeBps) ||
        performanceFeeBps < 0 ||
        performanceFeeBps > 2_000 ||
        !Number.isSafeInteger(maximumSlippageBps) ||
        maximumSlippageBps < 0 ||
        maximumSlippageBps > 10_000
      ) {
        throw new TypeError("indexed fee or slippage basis points are invalid");
      }
      const snapshot = navSnapshotSchema.parse(nav.snapshot);
      const basketNavValue = BigInt(snapshot.grossNavPusdUnits);
      const supply = BigInt(basketAccount.totalSharesOutstanding);
      let sharePrice: bigint;
      if (!basketAccount.hasInitializedSharePrice) {
        if (supply !== 0n) throw new TypeError("uninitialized basket has a non-zero indexed share supply");
        sharePrice = NAV_SHARE_PRICE_SCALE;
      } else {
        if (supply <= 0n || snapshot.sharePriceUnits === null) {
          throw new ApiRequestError(503, "nav_unavailable", "initialized basket does not have a priced NAV snapshot");
        }
        sharePrice = BigInt(snapshot.sharePriceUnits);
      }
      const executionAssets = basketAccount.items.map((item) => {
        const weightBps = Number(BigInt(item.weightBps));
        if (!Number.isSafeInteger(weightBps) || weightBps <= 0 || weightBps > 4_000) {
          throw new TypeError("indexed basket execution weight is invalid");
        }
        return Object.freeze({
          kind: "spot" in item.kind ? "spot" as const : "prediction_market" as const,
          weightBps,
        });
      });
      if (executionAssets.reduce((sum, item) => sum + item.weightBps, 0) !== 10_000) {
        throw new TypeError("indexed basket execution weights do not total 10,000 bps");
      }
      return Object.freeze({
        basket,
        user,
        compositionVersion,
        navReportHash: Buffer.from(nav.snapshot_hash, "hex"),
        basketNavValue,
        sharePrice,
        maximumSlippageBps,
        protocolFeeDestination: basketAccount.protocolFeeDestination,
        settlementMint: configAccount.settlementMint,
        performanceFeeBps,
        sharesOwned: position.sharesOwned,
        costBasisValue: position.costBasisValue,
        weightedDepositTimestamp: position.weightedDepositTimestamp,
        executionAssets: Object.freeze(executionAssets),
      });
    }, { isolation: "repeatable read", readOnly: true });
  }

  private async loadAccount<Schema extends z.ZodTypeAny>(
    transaction: SqlExecutor,
    address: string,
    kind: string,
    schema: Schema,
  ): Promise<z.output<Schema>> {
    const result = await transaction.query<AccountProjectionRow>(
      `SELECT account_data FROM solana_account_projections
       WHERE address = $1 AND account_kind = $2 AND is_active = true`,
      [address, kind],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ApiRequestError(503, "index_not_ready", `${kind} account is not finalized in the read plane`);
    return schema.parse(row.account_data);
  }

  private async loadSingletonAccount<Schema extends z.ZodTypeAny>(
    transaction: SqlExecutor,
    kind: string,
    schema: Schema,
  ): Promise<z.output<Schema>> {
    const result = await transaction.query<AccountProjectionRow>(
      `SELECT account_data FROM solana_account_projections
       WHERE owner = $1 AND account_kind = $2 AND is_active = true
       ORDER BY source_slot DESC LIMIT 2`,
      [this.programId.toBase58(), kind],
    );
    if (result.rows.length !== 1) {
      throw new ApiRequestError(503, "index_not_ready", `expected exactly one finalized ${kind} account`);
    }
    return schema.parse(result.rows[0]?.account_data);
  }

  private async loadPosition(
    transaction: SqlExecutor,
    basket: PublicKey,
    user: PublicKey,
  ): Promise<Readonly<{ sharesOwned: bigint; costBasisValue: bigint; weightedDepositTimestamp: bigint }>> {
    const [position] = derivePositionPda(basket, user, this.programId);
    const result = await transaction.query<AccountProjectionRow>(
      `SELECT account_data FROM solana_account_projections
       WHERE address = $1 AND account_kind = 'Position' AND is_active = true`,
      [position.toBase58()],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return Object.freeze({ sharesOwned: 0n, costBasisValue: 0n, weightedDepositTimestamp: 0n });
    }
    const parsed = positionAccountSchema.parse(row.account_data);
    return Object.freeze({
      sharesOwned: BigInt(parsed.sharesOwned),
      costBasisValue: BigInt(parsed.costBasisValue),
      weightedDepositTimestamp: BigInt(parsed.weightedDepositTimestamp),
    });
  }

  private async loadNav(
    transaction: SqlExecutor,
    basketId: string,
    reportHash: string | null,
  ): Promise<NavRow> {
    const result = await transaction.query<NavRow>(
      reportHash === null
        ? `SELECT snapshot_hash, observed_at_ms::text AS observed_at_ms, snapshot
           FROM nav_snapshots WHERE basket_id = $1
           ORDER BY sequence DESC LIMIT 1`
        : `SELECT snapshot_hash, observed_at_ms::text AS observed_at_ms, snapshot
           FROM nav_snapshots WHERE basket_id = $1 AND snapshot_hash = $2`,
      reportHash === null ? [basketId] : [basketId, reportHash],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApiRequestError(503, "nav_unavailable", "requested basket NAV snapshot is unavailable");
    }
    const observedAt = BigInt(row.observed_at_ms);
    const now = this.nowMs();
    if (observedAt > now || now - observedAt > this.maxNavAgeMs) {
      throw new ApiRequestError(409, "stale_nav", "requested basket NAV snapshot is stale");
    }
    if (!/^[0-9a-f]{64}$/u.test(row.snapshot_hash) || row.snapshot_hash === "0".repeat(64)) {
      throw new TypeError("stored NAV snapshot hash is invalid");
    }
    return row;
  }
}

export class PostgresFinancialRequestStore implements FinancialRequestStorePort {
  public constructor(private readonly sql: SqlClient) {}

  public async createIntent(request: {
    readonly operationId: string;
    readonly requestKey: string;
    readonly requestHash: string;
    readonly workflowId: string;
    readonly wallet: ExecutionWalletRoute;
    readonly quote: DepositQuote | WithdrawalQuote;
    readonly intent: SignedDepositIntent | SignedWithdrawalIntent;
    readonly now: Date;
  }): Promise<PersistedApiOperation> {
    if (request.quote.kind !== request.intent.kind) throw new TypeError("quote and intent kinds differ");
    return this.sql.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO execution_operations (
           id, request_key, request_hash, kind, state, workflow_id, basket,
           user_address, checkpoint, version, created_at, updated_at
         ) VALUES (
           $1::uuid, $2, $3, $4, 'created', $5, $6, $7, '{}'::jsonb, 0, $8, $8
         ) ON CONFLICT (request_key) DO NOTHING`,
        [
          request.operationId,
          request.requestKey,
          request.requestHash,
          request.quote.kind,
          request.workflowId,
          request.quote.basket.toBase58(),
          request.quote.user.toBase58(),
          request.now,
        ],
      );
      const identityResult = await transaction.query<IdentityRow>(
        `SELECT id::text AS id, request_hash, kind
         FROM execution_operations WHERE request_key = $1 FOR UPDATE`,
        [request.requestKey],
      );
      const identity = identityResult.rows[0];
      if (identity === undefined) throw new Error("execution operation disappeared after insert");
      if (identity.request_hash !== request.requestHash || identity.kind !== request.quote.kind) {
        throw new ApiRequestError(409, "idempotency_conflict", "Idempotency-Key was already used for different intent content");
      }
      const quoteId = randomUUID();
      await transaction.query(
        `INSERT INTO financial_quotes (
           id, operation_id, quote_hash, quote_kind, composition_version,
           nav_report_hash, share_price, expires_at, payload, created_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7::numeric,
           to_timestamp($8::numeric), $9::jsonb, $10
         ) ON CONFLICT (operation_id, quote_kind) DO NOTHING`,
        [
          quoteId,
          identity.id,
          request.quote.quoteHash.toString("hex"),
          request.quote.kind,
          request.quote.compositionVersion,
          request.quote.navReportHash.toString("hex"),
          request.quote.sharePrice.toString(10),
          request.quote.expiresAtSeconds.toString(10),
          json(serializeFinancialQuote(request.quote)),
          request.now,
        ],
      );
      const persistedQuote = await transaction.query<{ id: string; quote_hash: string }>(
        `SELECT id::text AS id, quote_hash FROM financial_quotes
         WHERE operation_id = $1::uuid AND quote_kind = $2`,
        [identity.id, request.quote.kind],
      );
      const quoteRow = persistedQuote.rows[0];
      if (quoteRow === undefined || quoteRow.quote_hash !== request.quote.quoteHash.toString("hex")) {
        throw new ApiRequestError(409, "idempotency_conflict", "persisted quote does not match the submitted intent");
      }
      await transaction.query(
        `INSERT INTO signed_intents (
           id, operation_id, quote_id, intent_nonce, intent_hash,
           encoded_message, signer_public_key, signature, verified_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::numeric, $5,
           $6, $7, $8, $9
         ) ON CONFLICT (operation_id) DO NOTHING`,
        [
          randomUUID(),
          identity.id,
          quoteRow.id,
          request.intent.nonce.toString(10),
          request.intent.intentHash.toString("hex"),
          request.intent.encodedMessage,
          request.quote.user.toBytes(),
          request.intent.signature,
          request.now,
        ],
      );
      const destination = request.intent.kind === "withdrawal"
        ? request.intent.destination.toBase58()
        : null;
      await transaction.query(
        `INSERT INTO execution_work_items (
           operation_id, state, wallet_id, polymarket_wallet,
           withdrawal_destination, next_attempt_at, created_at, updated_at
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6, $6, $6
         ) ON CONFLICT (operation_id) DO NOTHING`,
        [
          identity.id,
          request.quote.kind === "deposit" ? "awaiting_funding" : "pending",
          request.wallet.walletId,
          request.wallet.polygonAddress,
          destination,
          request.now,
        ],
      );
      const existing = await this.loadOperationWith(transaction, identity.id);
      if (existing.walletId !== request.wallet.walletId) {
        throw new ApiRequestError(409, "wallet_assignment_conflict", "operation was persisted with a different wallet assignment");
      }
      return existing;
    }, { isolation: "serializable", maxSerializationRetries: 3 });
  }

  public async setDepositFundingAddress(
    operationId: string,
    address: string,
    now: Date,
  ): Promise<PersistedApiOperation> {
    if (address.length < 32 || address.length > 128) throw new TypeError("deposit funding address is invalid");
    return this.sql.transaction(async (transaction) => {
      const operation = await this.loadOperationWith(transaction, operationId, true);
      if (operation.kind !== "deposit") throw new ApiRequestError(409, "wrong_operation_kind", "operation is not a deposit");
      if (operation.fundingAddress !== null) return operation;
      const updated = await transaction.query(
        `UPDATE execution_work_items
         SET funding_address = $2, updated_at = $3
         WHERE operation_id = $1::uuid AND funding_address IS NULL`,
        [operationId, address, now],
      );
      if (updated.rowCount !== 1) return this.loadOperationWith(transaction, operationId);
      if (operation.state === "created") {
        await transaction.query(
          `UPDATE execution_operations
           SET state = 'intent_verified',
               checkpoint = jsonb_build_object('bridgeAddress', $2::text),
               version = version + 1, updated_at = $3
           WHERE id = $1::uuid AND state = 'created'`,
          [operationId, address, now],
        );
      }
      return this.loadOperationWith(transaction, operationId);
    }, { isolation: "serializable", maxSerializationRetries: 3 });
  }

  public async submitDepositFunding(
    operationId: string,
    transactionSignature: string,
    idempotencyKey: string,
    now: Date,
  ): Promise<PersistedApiOperation> {
    return this.sql.transaction(async (transaction) => {
      const operation = await this.loadOperationWith(transaction, operationId, true);
      if (operation.kind !== "deposit") throw new ApiRequestError(409, "wrong_operation_kind", "operation is not a deposit");
      if (operation.fundingAddress === null) throw new ApiRequestError(409, "funding_not_prepared", "deposit funding route has not been prepared");
      if (operation.fundingTransactionSignature !== null) {
        if (operation.fundingTransactionSignature !== transactionSignature) {
          throw new ApiRequestError(409, "funding_conflict", "a different funding transaction is already attached");
        }
        return operation;
      }
      const result = await transaction.query(
        `UPDATE execution_work_items
         SET funding_transaction_signature = $2,
             funding_idempotency_key = $3,
             state = 'pending', next_attempt_at = $4, updated_at = $4
         WHERE operation_id = $1::uuid
           AND state = 'awaiting_funding'
           AND funding_transaction_signature IS NULL`,
        [operationId, transactionSignature, idempotencyKey, now],
      );
      if (result.rowCount !== 1) {
        const current = await this.loadOperationWith(transaction, operationId);
        if (current.fundingTransactionSignature === transactionSignature) return current;
        throw new ApiRequestError(409, "funding_state_conflict", "deposit operation is not awaiting funding");
      }
      return this.loadOperationWith(transaction, operationId);
    }, { isolation: "serializable", maxSerializationRetries: 3 });
  }

  public async loadOperation(operationId: string): Promise<PersistedApiOperation | null> {
    try {
      return await this.loadOperationWith(this.sql, operationId);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "operation_not_found") return null;
      throw error;
    }
  }

  public async initializeBasketPortfolio(request: {
    readonly basketId: string;
    readonly compositionHash: string;
    readonly items: readonly Readonly<{
      readonly assetKind?: "prediction_market" | "spot";
      readonly marketId: string;
      readonly conditionId?: string;
      readonly tokenId: string;
      readonly outcome: string;
      readonly tokenDecimals?: number;
      readonly initialMarkPriceUnits: bigint;
      readonly markObservedAtMs: bigint;
      readonly markSourceHash: string;
    }>[];
    readonly now: Date;
  }): Promise<void> {
    if (!/^[0-9a-f]{64}$/u.test(request.compositionHash) || request.compositionHash === "0".repeat(64)) {
      throw new TypeError("basket composition hash is invalid");
    }
    await this.sql.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO basket_portfolio_states (
           basket_id, ledger_version, composition_version,
           composition_hash, idle_pusd_units, idle_usdc_units, updated_at
         ) VALUES ($1, $2, 1, $3, 0, 0, $4)
         ON CONFLICT (basket_id) DO NOTHING`,
        [
          request.basketId,
          `basket-created:${request.compositionHash}`,
          request.compositionHash,
          request.now,
        ],
      );
      const result = await transaction.query<PortfolioIdentityRow>(
        `SELECT composition_hash, composition_version::text AS composition_version
         FROM basket_portfolio_states WHERE basket_id = $1`,
        [request.basketId],
      );
      const row = result.rows[0];
      if (row === undefined || row.composition_hash !== request.compositionHash || row.composition_version !== "1") {
        throw new Error("basket portfolio bootstrap conflicts with existing state");
      }
      for (const item of request.items) {
        const assetKind = item.assetKind ?? "prediction_market";
        if (
          assetKind === "spot" &&
          (
            item.tokenDecimals === undefined ||
            !Number.isInteger(item.tokenDecimals) ||
            item.tokenDecimals < 0 ||
            item.tokenDecimals > 18
          )
        ) {
          throw new TypeError("spot basket item requires canonical token decimals");
        }
        if (
          assetKind === "prediction_market" &&
          item.tokenDecimals !== undefined
        ) {
          throw new TypeError("prediction basket item cannot carry token decimals");
        }
        await transaction.query(
          `INSERT INTO basket_holding_projections (
             basket_id, market_id, token_id, condition_id, negative_risk,
             outcome, quantity_units, mark_price_units, price_scale,
             mark_observed_at_ms, mark_source_hash, mark_condition, updated_at,
             asset_kind, token_decimals
           ) VALUES (
             $1, $2, $3, $4, NULL, $5, 0, $6::numeric, $7::numeric,
             $8::numeric, $9, 'fresh', $10, $11, $12
           )
           ON CONFLICT (basket_id, market_id, token_id, outcome) DO NOTHING`,
          [
            request.basketId,
            item.marketId,
            item.tokenId,
            item.conditionId ?? null,
            item.outcome,
            item.initialMarkPriceUnits.toString(10),
            (assetKind === "spot"
              ? 10n ** BigInt(item.tokenDecimals as number)
              : NAV_SHARE_PRICE_SCALE).toString(10),
            item.markObservedAtMs.toString(10),
            item.markSourceHash,
            request.now,
            assetKind,
            item.tokenDecimals ?? null,
          ],
        );
      }
      const holdings = await transaction.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM basket_holding_projections
         WHERE basket_id = $1`,
        [request.basketId],
      );
      if (BigInt(holdings.rows[0]?.count ?? "0") !== BigInt(request.items.length)) {
        throw new Error("basket portfolio holdings conflict with the Composer result");
      }
    }, { isolation: "serializable" });
  }

  private async loadOperationWith(
    executor: SqlExecutor,
    operationId: string,
    lock = false,
  ): Promise<PersistedApiOperation> {
    const result = await executor.query<OperationRow>(
      `SELECT ${operationColumns}
       FROM execution_operations o
       JOIN execution_work_items w ON w.operation_id = o.id
       WHERE o.id = $1::uuid
       ${lock ? "FOR UPDATE OF o, w" : ""}`,
      [operationId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ApiRequestError(404, "operation_not_found", "execution operation was not found");
    return mapOperation(row);
  }
}
