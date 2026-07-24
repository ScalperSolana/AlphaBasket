import type {
  LedgerAccount,
  LedgerBalance,
  LedgerPostResult,
  LedgerTransaction,
  LedgerTransactionDraft,
  NewLedgerAccount,
} from "./types.js";

export interface LedgerRepository {
  createAccount(account: NewLedgerAccount): Promise<LedgerAccount>;
  findAccountById(accountId: string): Promise<LedgerAccount | undefined>;
  findAccountByKey(accountKey: string): Promise<LedgerAccount | undefined>;
  findAccountsByIds(accountIds: readonly string[]): Promise<readonly LedgerAccount[]>;
  postTransaction(
    transaction: LedgerTransactionDraft,
    fingerprint: string,
  ): Promise<LedgerPostResult>;
  findTransactionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<LedgerTransaction | undefined>;
  getBalances(accountIds: readonly string[]): Promise<readonly LedgerBalance[]>;
}
