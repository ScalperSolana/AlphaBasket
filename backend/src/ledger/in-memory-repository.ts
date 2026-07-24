import {
  LedgerAccountConflictError,
  LedgerAccountNotFoundError,
  LedgerIdempotencyConflictError,
  LedgerInsufficientBalanceError,
} from "./errors.js";
import type { LedgerRepository } from "./repository.js";
import type {
  LedgerAccount,
  LedgerBalance,
  LedgerPostResult,
  LedgerTransaction,
  LedgerTransactionDraft,
  NewLedgerAccount,
} from "./types.js";
import { validateLedgerTransaction } from "./validation.js";

function cloneAccount(account: LedgerAccount): LedgerAccount {
  return {
    ...account,
    createdAt: new Date(account.createdAt),
  };
}

function cloneTransaction(transaction: LedgerTransaction): LedgerTransaction {
  return {
    ...transaction,
    occurredAt: new Date(transaction.occurredAt),
    createdAt: new Date(transaction.createdAt),
    entries: transaction.entries.map((entry) => ({ ...entry })),
    metadata: { ...transaction.metadata },
  };
}

function sameAccount(left: LedgerAccount, right: NewLedgerAccount): boolean {
  return (
    left.id === right.id &&
    left.accountKey === right.accountKey &&
    left.assetCode === right.assetCode &&
    left.kind === right.kind &&
    left.basketId === right.basketId &&
    left.executionWalletId === right.executionWalletId
  );
}

export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly accountsById = new Map<string, LedgerAccount>();
  private readonly accountIdByKey = new Map<string, string>();
  private readonly transactionsByIdempotencyKey = new Map<
    string,
    LedgerTransaction
  >();

  public async createAccount(account: NewLedgerAccount): Promise<LedgerAccount> {
    const existingId = this.accountIdByKey.get(account.accountKey);
    const existing =
      this.accountsById.get(account.id) ??
      (existingId === undefined ? undefined : this.accountsById.get(existingId));

    if (existing !== undefined) {
      if (!sameAccount(existing, account)) {
        throw new LedgerAccountConflictError(account.accountKey);
      }
      return cloneAccount(existing);
    }

    const created = cloneAccount(account);
    this.accountsById.set(created.id, created);
    this.accountIdByKey.set(created.accountKey, created.id);
    return cloneAccount(created);
  }

  public async findAccountById(
    accountId: string,
  ): Promise<LedgerAccount | undefined> {
    const account = this.accountsById.get(accountId);
    return account === undefined ? undefined : cloneAccount(account);
  }

  public async findAccountByKey(
    accountKey: string,
  ): Promise<LedgerAccount | undefined> {
    const id = this.accountIdByKey.get(accountKey);
    if (id === undefined) {
      return undefined;
    }
    return this.findAccountById(id);
  }

  public async findAccountsByIds(
    accountIds: readonly string[],
  ): Promise<readonly LedgerAccount[]> {
    return accountIds.flatMap((accountId) => {
      const account = this.accountsById.get(accountId);
      return account === undefined ? [] : [cloneAccount(account)];
    });
  }

  public async postTransaction(
    transaction: LedgerTransactionDraft,
    fingerprint: string,
  ): Promise<LedgerPostResult> {
    const existing = this.transactionsByIdempotencyKey.get(
      transaction.idempotencyKey,
    );
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new LedgerIdempotencyConflictError(transaction.idempotencyKey);
      }
      return { transaction: cloneTransaction(existing), created: false };
    }

    for (const entry of transaction.entries) {
      if (!this.accountsById.has(entry.accountId)) {
        throw new LedgerAccountNotFoundError(entry.accountId);
      }
    }

    const accountIds = [...new Set(transaction.entries.map((entry) => entry.accountId))];
    const accounts = accountIds.map((accountId) => {
      const account = this.accountsById.get(accountId);
      if (account === undefined) {
        throw new LedgerAccountNotFoundError(accountId);
      }
      return account;
    });
    validateLedgerTransaction(transaction, accounts);

    const currentBalances = new Map(accountIds.map((accountId) => [accountId, 0n]));
    for (const persisted of this.transactionsByIdempotencyKey.values()) {
      for (const entry of persisted.entries) {
        if (currentBalances.has(entry.accountId)) {
          const delta = entry.side === "debit" ? entry.amount : -entry.amount;
          currentBalances.set(
            entry.accountId,
            (currentBalances.get(entry.accountId) ?? 0n) + delta,
          );
        }
      }
    }
    for (const entry of transaction.entries) {
      const delta = entry.side === "debit" ? entry.amount : -entry.amount;
      currentBalances.set(
        entry.accountId,
        (currentBalances.get(entry.accountId) ?? 0n) + delta,
      );
    }
    for (const account of accounts) {
      const balance = currentBalances.get(account.id) ?? 0n;
      if (account.kind !== "unallocated" && balance < 0n) {
        throw new LedgerInsufficientBalanceError(account.id, balance);
      }
    }

    const created: LedgerTransaction = {
      id: transaction.id,
      idempotencyKey: transaction.idempotencyKey,
      referenceType: transaction.referenceType,
      referenceId: transaction.referenceId,
      occurredAt: new Date(transaction.occurredAt),
      entries: transaction.entries.map((entry, sequence) => ({
        ...entry,
        sequence,
      })),
      metadata: { ...(transaction.metadata ?? {}) },
      fingerprint,
      createdAt: new Date(),
    };
    this.transactionsByIdempotencyKey.set(
      transaction.idempotencyKey,
      created,
    );
    return { transaction: cloneTransaction(created), created: true };
  }

  public async findTransactionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<LedgerTransaction | undefined> {
    const transaction = this.transactionsByIdempotencyKey.get(idempotencyKey);
    return transaction === undefined ? undefined : cloneTransaction(transaction);
  }

  public async getBalances(
    accountIds: readonly string[],
  ): Promise<readonly LedgerBalance[]> {
    const requested = new Set(accountIds);
    const balances = new Map(accountIds.map((id) => [id, 0n]));
    for (const transaction of this.transactionsByIdempotencyKey.values()) {
      for (const entry of transaction.entries) {
        if (requested.has(entry.accountId)) {
          const signedAmount = entry.side === "debit" ? entry.amount : -entry.amount;
          balances.set(
            entry.accountId,
            (balances.get(entry.accountId) ?? 0n) + signedAmount,
          );
        }
      }
    }

    return accountIds.map((accountId) => ({
      accountId,
      amount: balances.get(accountId) ?? 0n,
    }));
  }
}
