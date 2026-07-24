export const LEDGER_ACCOUNT_KINDS = [
  "available",
  "reserved",
  "bridge_in_flight",
  "position",
  "fee",
  "unallocated",
] as const;

export type LedgerAccountKind = (typeof LEDGER_ACCOUNT_KINDS)[number];
export type LedgerSide = "debit" | "credit";

export interface LedgerAccount {
  readonly id: string;
  readonly accountKey: string;
  readonly assetCode: string;
  readonly kind: LedgerAccountKind;
  readonly basketId?: string;
  readonly executionWalletId?: string;
  readonly createdAt: Date;
}

export interface NewLedgerAccount {
  readonly id: string;
  readonly accountKey: string;
  readonly assetCode: string;
  readonly kind: LedgerAccountKind;
  readonly basketId?: string;
  readonly executionWalletId?: string;
  readonly createdAt: Date;
}

export interface LedgerEntryDraft {
  readonly accountId: string;
  readonly side: LedgerSide;
  readonly amount: bigint;
}

export type LedgerMetadata = Readonly<Record<string, string | boolean | null>>;

export interface LedgerTransactionDraft {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly occurredAt: Date;
  readonly entries: readonly LedgerEntryDraft[];
  readonly metadata?: LedgerMetadata;
}

export interface LedgerEntry extends LedgerEntryDraft {
  readonly sequence: number;
}

export interface LedgerTransaction
  extends Omit<LedgerTransactionDraft, "entries" | "metadata"> {
  readonly entries: readonly LedgerEntry[];
  readonly metadata: LedgerMetadata;
  readonly fingerprint: string;
  readonly createdAt: Date;
}

export interface LedgerPostResult {
  readonly transaction: LedgerTransaction;
  readonly created: boolean;
}

export interface LedgerTransferRequest {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly occurredAt: Date;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amount: bigint;
  readonly metadata?: LedgerMetadata;
}

export interface LedgerBalance {
  readonly accountId: string;
  readonly amount: bigint;
}
