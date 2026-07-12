import { LedgerValidationError } from "./errors.js";
import type { LedgerRepository } from "./repository.js";
import type {
  LedgerAccount,
  LedgerPostResult,
  LedgerTransactionDraft,
  LedgerTransferRequest,
  NewLedgerAccount,
} from "./types.js";
import { ledgerFingerprint, validateLedgerTransaction } from "./validation.js";

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function assertMoveKinds(
  from: LedgerAccount,
  to: LedgerAccount,
  expectedFrom: LedgerAccount["kind"],
  expectedTo: LedgerAccount["kind"],
): void {
  if (from.kind !== expectedFrom || to.kind !== expectedTo) {
    throw new LedgerValidationError(
      `invalid ledger move: expected ${expectedFrom} -> ${expectedTo}, received ${from.kind} -> ${to.kind}`,
    );
  }
}

function assertSameAttribution(from: LedgerAccount, to: LedgerAccount): void {
  if (
    from.assetCode !== to.assetCode ||
    from.basketId !== to.basketId ||
    from.executionWalletId !== to.executionWalletId
  ) {
    throw new LedgerValidationError(
      "reservation and bridge moves must preserve asset, basket, and execution-wallet attribution",
    );
  }
}

export class LedgerService {
  public constructor(private readonly repository: LedgerRepository) {}

  public createAccount(account: NewLedgerAccount): Promise<LedgerAccount> {
    if (account.assetCode.length === 0 || account.accountKey.length === 0) {
      throw new LedgerValidationError("accountKey and assetCode must not be empty");
    }
    if (!Number.isFinite(account.createdAt.getTime())) {
      throw new LedgerValidationError("account.createdAt must be valid");
    }
    return this.repository.createAccount(account);
  }

  public async post(
    transaction: LedgerTransactionDraft,
  ): Promise<LedgerPostResult> {
    const accountIds = unique(
      transaction.entries.map((entry) => entry.accountId),
    );
    const accounts = await this.repository.findAccountsByIds(accountIds);
    validateLedgerTransaction(transaction, accounts);
    return this.repository.postTransaction(
      transaction,
      ledgerFingerprint(transaction),
    );
  }

  public async transfer(request: LedgerTransferRequest): Promise<LedgerPostResult> {
    if (request.fromAccountId === request.toAccountId) {
      throw new LedgerValidationError("transfer accounts must be different");
    }

    return this.post({
      id: request.id,
      idempotencyKey: request.idempotencyKey,
      referenceType: request.referenceType,
      referenceId: request.referenceId,
      occurredAt: request.occurredAt,
      entries: [
        {
          accountId: request.fromAccountId,
          side: "credit",
          amount: request.amount,
        },
        {
          accountId: request.toAccountId,
          side: "debit",
          amount: request.amount,
        },
      ],
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    });
  }

  public async reserve(request: LedgerTransferRequest): Promise<LedgerPostResult> {
    const [from, to] = await this.requireAccounts([
      request.fromAccountId,
      request.toAccountId,
    ]);
    assertSameAttribution(from, to);
    assertMoveKinds(from, to, "available", "reserved");
    return this.transfer(request);
  }

  public async releaseReservation(
    request: LedgerTransferRequest,
  ): Promise<LedgerPostResult> {
    const [from, to] = await this.requireAccounts([
      request.fromAccountId,
      request.toAccountId,
    ]);
    assertSameAttribution(from, to);
    assertMoveKinds(from, to, "reserved", "available");
    return this.transfer(request);
  }

  public async moveToBridgeInFlight(
    request: LedgerTransferRequest,
  ): Promise<LedgerPostResult> {
    const [from, to] = await this.requireAccounts([
      request.fromAccountId,
      request.toAccountId,
    ]);
    assertSameAttribution(from, to);
    if (
      (from.kind !== "available" && from.kind !== "reserved") ||
      to.kind !== "bridge_in_flight"
    ) {
      throw new LedgerValidationError(
        `invalid bridge move: ${from.kind} -> ${to.kind}`,
      );
    }
    return this.transfer(request);
  }

  private async requireAccounts(
    accountIds: readonly [string, string],
  ): Promise<readonly [LedgerAccount, LedgerAccount]> {
    const accounts = await this.repository.findAccountsByIds(accountIds);
    const byId = new Map(accounts.map((account) => [account.id, account]));
    const first = byId.get(accountIds[0]);
    const second = byId.get(accountIds[1]);
    if (first === undefined || second === undefined) {
      throw new LedgerValidationError("ledger move references an unknown account");
    }
    return [first, second];
  }
}
