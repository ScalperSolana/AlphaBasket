import {
  LedgerAccountConflictError,
  LedgerIdempotencyConflictError,
  LedgerInsufficientBalanceError,
} from "./errors.js";
import type { LedgerRepository } from "./repository.js";
import type {
  LedgerAccount,
  LedgerAccountKind,
  LedgerBalance,
  LedgerEntry,
  LedgerMetadata,
  LedgerPostResult,
  LedgerSide,
  LedgerTransaction,
  LedgerTransactionDraft,
  NewLedgerAccount,
} from "./types.js";
import type { SqlClient, SqlExecutor } from "../persistence/sql-client.js";

interface AccountRow extends Record<string, unknown> {
  id: string;
  account_key: string;
  asset_code: string;
  kind: LedgerAccountKind;
  basket_id: string | null;
  execution_wallet_id: string | null;
  created_at: Date;
}

interface TransactionRow extends Record<string, unknown> {
  id: string;
  idempotency_key: string;
  reference_type: string;
  reference_id: string;
  occurred_at: Date;
  metadata: LedgerMetadata;
  fingerprint: string;
  created_at: Date;
}

interface EntryRow extends Record<string, unknown> {
  sequence: number;
  account_id: string;
  side: LedgerSide;
  amount: string;
}

interface BalanceRow extends Record<string, unknown> {
  account_id: string;
  amount: string;
}

function optional<Key extends string, Value>(
  key: Key,
  value: Value | null,
): { readonly [Property in Key]?: Value } {
  return value === null ? {} : ({ [key]: value } as {
      readonly [Property in Key]?: Value;
    });
}

function mapAccount(row: AccountRow): LedgerAccount {
  return {
    id: row.id,
    accountKey: row.account_key,
    assetCode: row.asset_code,
    kind: row.kind,
    ...optional("basketId", row.basket_id),
    ...optional("executionWalletId", row.execution_wallet_id),
    createdAt: row.created_at,
  };
}

function parseBaseUnits(value: string): bigint {
  if (!/^-?[0-9]+$/u.test(value)) {
    throw new TypeError(`database returned a non-integral amount: ${value}`);
  }
  return BigInt(value);
}

function mapEntry(row: EntryRow): LedgerEntry {
  return {
    sequence: row.sequence,
    accountId: row.account_id,
    side: row.side,
    amount: parseBaseUnits(row.amount),
  };
}

async function loadTransaction(
  sql: SqlExecutor,
  idempotencyKey: string,
): Promise<LedgerTransaction | undefined> {
  const transactionResult = await sql.query<TransactionRow>(
    `SELECT id, idempotency_key, reference_type, reference_id,
            occurred_at, metadata, fingerprint, created_at
     FROM ledger_transactions
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = transactionResult.rows[0];
  if (row === undefined) {
    return undefined;
  }

  const entries = await sql.query<EntryRow>(
    `SELECT sequence, account_id, side, amount::text AS amount
     FROM ledger_entries
     WHERE transaction_id = $1
     ORDER BY sequence`,
    [row.id],
  );

  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    occurredAt: row.occurred_at,
    metadata: row.metadata,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    entries: entries.rows.map(mapEntry),
  };
}

export class PostgresLedgerRepository implements LedgerRepository {
  public constructor(private readonly sql: SqlClient) {}

  public async createAccount(account: NewLedgerAccount): Promise<LedgerAccount> {
    const inserted = await this.sql.query<AccountRow>(
      `INSERT INTO ledger_accounts (
         id, account_key, asset_code, kind, basket_id,
         execution_wallet_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (account_key) DO NOTHING
       RETURNING *`,
      [
        account.id,
        account.accountKey,
        account.assetCode,
        account.kind,
        account.basketId ?? null,
        account.executionWalletId ?? null,
        account.createdAt,
      ],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow !== undefined) {
      return mapAccount(insertedRow);
    }

    const existing = await this.findAccountByKey(account.accountKey);
    if (
      existing === undefined ||
      existing.id !== account.id ||
      existing.assetCode !== account.assetCode ||
      existing.kind !== account.kind ||
      existing.basketId !== account.basketId ||
      existing.executionWalletId !== account.executionWalletId
    ) {
      throw new LedgerAccountConflictError(account.accountKey);
    }
    return existing;
  }

  public async findAccountById(
    accountId: string,
  ): Promise<LedgerAccount | undefined> {
    const result = await this.sql.query<AccountRow>(
      "SELECT * FROM ledger_accounts WHERE id = $1",
      [accountId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapAccount(row);
  }

  public async findAccountByKey(
    accountKey: string,
  ): Promise<LedgerAccount | undefined> {
    const result = await this.sql.query<AccountRow>(
      "SELECT * FROM ledger_accounts WHERE account_key = $1",
      [accountKey],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapAccount(row);
  }

  public async findAccountsByIds(
    accountIds: readonly string[],
  ): Promise<readonly LedgerAccount[]> {
    if (accountIds.length === 0) {
      return [];
    }
    const result = await this.sql.query<AccountRow>(
      "SELECT * FROM ledger_accounts WHERE id = ANY($1::uuid[])",
      [accountIds],
    );
    return result.rows.map(mapAccount);
  }

  public async postTransaction(
    transaction: LedgerTransactionDraft,
    fingerprint: string,
  ): Promise<LedgerPostResult> {
    return this.sql.transaction(
      async (sql) => {
        const inserted = await sql.query<{ id: string }>(
          `INSERT INTO ledger_transactions (
             id, idempotency_key, reference_type, reference_id,
             occurred_at, metadata, fingerprint
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [
            transaction.id,
            transaction.idempotencyKey,
            transaction.referenceType,
            transaction.referenceId,
            transaction.occurredAt,
            JSON.stringify(transaction.metadata ?? {}),
            fingerprint,
          ],
        );

        const created = inserted.rowCount === 1;
        if (!created) {
          const persisted = await loadTransaction(
            sql,
            transaction.idempotencyKey,
          );
          if (persisted === undefined) {
            throw new Error("ledger transaction disappeared during idempotent post");
          }
          if (persisted.fingerprint !== fingerprint) {
            throw new LedgerIdempotencyConflictError(transaction.idempotencyKey);
          }
          return { transaction: persisted, created: false };
        }

        const accountIds = [
          ...new Set(transaction.entries.map((entry) => entry.accountId)),
        ].sort();
        const lockedAccounts = await sql.query<AccountRow>(
          `SELECT *
           FROM ledger_accounts
           WHERE id = ANY($1::uuid[])
           ORDER BY id
           FOR UPDATE`,
          [accountIds],
        );
        if (lockedAccounts.rowCount !== accountIds.length) {
          throw new Error("ledger transaction references an unknown account");
        }

        const current = await sql.query<BalanceRow>(
          `SELECT account.id AS account_id,
                  COALESCE(SUM(
                    CASE entry.side
                      WHEN 'debit' THEN entry.amount
                      ELSE -entry.amount
                    END
                  ), 0)::text AS amount
           FROM ledger_accounts AS account
           LEFT JOIN ledger_entries AS entry ON entry.account_id = account.id
           WHERE account.id = ANY($1::uuid[])
           GROUP BY account.id`,
          [accountIds],
        );
        const balances = new Map(
          current.rows.map((row) => [
            row.account_id,
            parseBaseUnits(row.amount),
          ]),
        );
        for (const entry of transaction.entries) {
          const delta = entry.side === "debit" ? entry.amount : -entry.amount;
          balances.set(
            entry.accountId,
            (balances.get(entry.accountId) ?? 0n) + delta,
          );
        }
        for (const accountRow of lockedAccounts.rows) {
          const balance = balances.get(accountRow.id) ?? 0n;
          if (accountRow.kind !== "unallocated" && balance < 0n) {
            throw new LedgerInsufficientBalanceError(accountRow.id, balance);
          }
        }

        for (const [sequence, entry] of transaction.entries.entries()) {
          await sql.query(
            `INSERT INTO ledger_entries (
               transaction_id, sequence, account_id, side, amount
             ) VALUES ($1, $2, $3, $4, $5::numeric)`,
            [
              transaction.id,
              sequence,
              entry.accountId,
              entry.side,
              entry.amount,
            ],
          );
        }

        const persisted = await loadTransaction(
          sql,
          transaction.idempotencyKey,
        );
        if (persisted === undefined) {
          throw new Error("ledger transaction disappeared during post");
        }
        if (persisted.fingerprint !== fingerprint) {
          throw new LedgerIdempotencyConflictError(transaction.idempotencyKey);
        }
        return { transaction: persisted, created: true };
      },
      { isolation: "serializable" },
    );
  }

  public findTransactionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<LedgerTransaction | undefined> {
    return loadTransaction(this.sql, idempotencyKey);
  }

  public async getBalances(
    accountIds: readonly string[],
  ): Promise<readonly LedgerBalance[]> {
    if (accountIds.length === 0) {
      return [];
    }
    const result = await this.sql.query<BalanceRow>(
      `SELECT account.id AS account_id,
              COALESCE(SUM(
                CASE entry.side
                  WHEN 'debit' THEN entry.amount
                  ELSE -entry.amount
                END
              ), 0)::text AS amount
       FROM ledger_accounts AS account
       LEFT JOIN ledger_entries AS entry ON entry.account_id = account.id
       WHERE account.id = ANY($1::uuid[])
       GROUP BY account.id`,
      [accountIds],
    );
    const byId = new Map(
      result.rows.map((row) => [row.account_id, parseBaseUnits(row.amount)]),
    );
    return accountIds.map((accountId) => ({
      accountId,
      amount: byId.get(accountId) ?? 0n,
    }));
  }
}
