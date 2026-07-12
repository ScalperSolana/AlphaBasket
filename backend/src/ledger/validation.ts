import { createHash } from "node:crypto";

import { LedgerAccountNotFoundError, LedgerValidationError } from "./errors.js";
import type {
  LedgerAccount,
  LedgerMetadata,
  LedgerTransactionDraft,
} from "./types.js";

function requireNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new LedgerValidationError(`${field} must not be empty`);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalMetadata(
  metadata: LedgerMetadata | undefined,
): readonly (readonly [string, string | boolean | null])[] {
  if (metadata === undefined) {
    return [];
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    (Object.getPrototypeOf(metadata) !== Object.prototype &&
      Object.getPrototypeOf(metadata) !== null)
  ) {
    throw new LedgerValidationError("transaction.metadata must be a plain object");
  }
  return Object.entries(metadata)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, value]) => {
      if (
        key.length === 0 ||
        (typeof value !== "string" &&
          typeof value !== "boolean" &&
          value !== null)
      ) {
        throw new LedgerValidationError(
          "metadata requires non-empty keys and string, boolean, or null values",
        );
      }
      return [key, value] as const;
    });
}

export function ledgerFingerprint(transaction: LedgerTransactionDraft): string {
  const entries = transaction.entries
    .map((entry) =>
      [entry.accountId, entry.side, entry.amount.toString(10)] as const,
    )
    .sort((left, right) =>
      compareCodeUnits(JSON.stringify(left), JSON.stringify(right)),
    );
  // A JSON tuple is used instead of delimiter concatenation so arbitrary IDs
  // and metadata keys cannot create ambiguous financial fingerprints.
  const content = JSON.stringify([
    "alphabasket-ledger-v1",
    transaction.referenceType,
    transaction.referenceId,
    canonicalMetadata(transaction.metadata),
    entries,
  ]);

  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function validateLedgerTransaction(
  transaction: LedgerTransactionDraft,
  accounts: readonly LedgerAccount[],
): void {
  requireNonEmpty(transaction.id, "transaction.id");
  requireNonEmpty(transaction.idempotencyKey, "transaction.idempotencyKey");
  requireNonEmpty(transaction.referenceType, "transaction.referenceType");
  requireNonEmpty(transaction.referenceId, "transaction.referenceId");

  if (!Number.isFinite(transaction.occurredAt.getTime())) {
    throw new LedgerValidationError("transaction.occurredAt must be valid");
  }
  if (transaction.entries.length < 2) {
    throw new LedgerValidationError("a ledger transaction requires at least two entries");
  }

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const totals = new Map<string, { debit: bigint; credit: bigint }>();

  for (const entry of transaction.entries) {
    requireNonEmpty(entry.accountId, "entry.accountId");
    if (entry.side !== "debit" && entry.side !== "credit") {
      throw new LedgerValidationError("entry.side must be debit or credit");
    }
    if (entry.amount <= 0n) {
      throw new LedgerValidationError("entry amounts must be positive base units");
    }

    const account = accountById.get(entry.accountId);
    if (account === undefined) {
      throw new LedgerAccountNotFoundError(entry.accountId);
    }

    const total = totals.get(account.assetCode) ?? { debit: 0n, credit: 0n };
    if (entry.side === "debit") {
      total.debit += entry.amount;
    } else {
      total.credit += entry.amount;
    }
    totals.set(account.assetCode, total);
  }

  for (const [assetCode, total] of totals) {
    if (total.debit !== total.credit) {
      throw new LedgerValidationError(
        `unbalanced ledger transaction for ${assetCode}: debit=${total.debit.toString(10)} credit=${total.credit.toString(10)}`,
      );
    }
  }
}
