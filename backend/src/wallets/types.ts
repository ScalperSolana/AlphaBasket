export type ExecutionWalletStatus = "active" | "draining" | "disabled";

export interface ExecutionWalletDescriptor {
  readonly walletId: string;
  readonly polygonAddress: string;
  readonly shard: string;
  readonly status: ExecutionWalletStatus;
  readonly maxConcurrentOperations?: number;
}

export interface ExecutionWalletRegistryPort {
  listWallets(): Promise<readonly ExecutionWalletDescriptor[]>;
}

export interface WalletAssignment {
  readonly basketId: string;
  readonly walletId: string;
  readonly shard: string;
  readonly strategyVersion: string;
  readonly assignedAtMs: bigint;
}

export interface WalletAssignmentStorePort {
  findByBasketId(basketId: string): Promise<WalletAssignment | null>;
  /** Atomically returns the existing assignment or persists and returns candidate. */
  putIfAbsent(candidate: WalletAssignment): Promise<WalletAssignment>;
}

export interface WalletSelectionStrategyPort {
  readonly version: string;
  select(
    basketId: string,
    wallets: readonly ExecutionWalletDescriptor[],
  ): ExecutionWalletDescriptor;
}

export interface WalletClockPort {
  nowMs(): bigint;
}

export interface WalletOperationLease {
  readonly walletId: string;
  readonly operationId: string;
  readonly ownerId: string;
  readonly token: string;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
}

export interface WalletOperationLeaseStorePort {
  tryAcquire(request: {
    readonly walletId: string;
    readonly operationId: string;
    readonly ownerId: string;
    readonly now: Date;
    readonly durationMs: number;
  }): Promise<WalletOperationLease | null>;
  renew(lease: WalletOperationLease, now: Date, durationMs: number): Promise<WalletOperationLease | null>;
  release(lease: WalletOperationLease): Promise<boolean>;
}

/** Serializes side-effecting work for one attributed execution wallet. */
export interface WalletExecutionCoordinatorPort {
  execute<Result>(
    walletId: string,
    operationId: string,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result>;
}
