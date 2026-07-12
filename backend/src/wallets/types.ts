export type ExecutionWalletStatus = "active" | "draining" | "disabled";

export interface ExecutionWalletDescriptor {
  readonly walletId: string;
  readonly polygonAddress: string;
  readonly shard: string;
  readonly status: ExecutionWalletStatus;
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
