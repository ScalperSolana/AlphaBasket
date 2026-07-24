export class LedgerValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LedgerValidationError";
  }
}

export class LedgerAccountNotFoundError extends Error {
  public constructor(public readonly accountId: string) {
    super(`ledger account not found: ${accountId}`);
    this.name = "LedgerAccountNotFoundError";
  }
}

export class LedgerIdempotencyConflictError extends Error {
  public constructor(public readonly idempotencyKey: string) {
    super(`idempotency key was already used for different ledger content: ${idempotencyKey}`);
    this.name = "LedgerIdempotencyConflictError";
  }
}

export class LedgerAccountConflictError extends Error {
  public constructor(public readonly accountKey: string) {
    super(`ledger account key already exists with different attributes: ${accountKey}`);
    this.name = "LedgerAccountConflictError";
  }
}

export class LedgerInsufficientBalanceError extends Error {
  public constructor(
    public readonly accountId: string,
    public readonly resultingBalance: bigint,
  ) {
    super(
      `ledger posting would make account ${accountId} negative: ${resultingBalance.toString(10)}`,
    );
    this.name = "LedgerInsufficientBalanceError";
  }
}
