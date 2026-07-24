import { createHash } from "node:crypto";
import type {
  ExecutionWalletDescriptor,
  ExecutionWalletRegistryPort,
  WalletAssignment,
  WalletAssignmentStorePort,
  WalletClockPort,
  WalletSelectionStrategyPort,
} from "./types.js";

export class NoActiveExecutionWalletError extends Error {
  public constructor() {
    super("No active execution wallet is available");
    this.name = "NoActiveExecutionWalletError";
  }
}

const score = (namespace: string, basketId: string, walletId: string): Buffer => {
  const hash = createHash("sha256");
  hash.update(namespace, "utf8");
  hash.update("\u0000", "utf8");
  hash.update(basketId, "utf8");
  hash.update("\u0000", "utf8");
  hash.update(walletId, "utf8");
  return hash.digest();
};

/** Consistent rendezvous hashing minimizes remaps as future wallet shards are added. */
export class RendezvousWalletSelectionStrategy implements WalletSelectionStrategyPort {
  public readonly version = "rendezvous-sha256-v1";

  public constructor(private readonly namespace = "ALPHABASKET_EXECUTION_WALLET_V1") {}

  public select(
    basketId: string,
    wallets: readonly ExecutionWalletDescriptor[],
  ): ExecutionWalletDescriptor {
    if (basketId.length === 0) {
      throw new TypeError("basketId must not be empty");
    }
    const active = wallets
      .filter((wallet) => wallet.status === "active")
      .sort((left, right) =>
        left.walletId < right.walletId ? -1 : left.walletId > right.walletId ? 1 : 0,
      );
    let selected: ExecutionWalletDescriptor | undefined;
    let selectedScore: Buffer | undefined;
    for (const wallet of active) {
      if (wallet.walletId.length === 0 || wallet.shard.length === 0) {
        throw new TypeError("walletId and shard must not be empty");
      }
      const candidateScore = score(this.namespace, basketId, wallet.walletId);
      if (selectedScore === undefined || Buffer.compare(candidateScore, selectedScore) > 0) {
        selected = wallet;
        selectedScore = candidateScore;
      }
    }
    if (selected === undefined) {
      throw new NoActiveExecutionWalletError();
    }
    return selected;
  }
}

export class StickyWalletAllocator {
  public constructor(
    private readonly assignments: WalletAssignmentStorePort,
    private readonly registry: ExecutionWalletRegistryPort,
    private readonly strategy: WalletSelectionStrategyPort,
    private readonly clock: WalletClockPort,
  ) {}

  public async allocate(basketId: string): Promise<WalletAssignment> {
    if (basketId.length === 0) {
      throw new TypeError("basketId must not be empty");
    }
    const existing = await this.assignments.findByBasketId(basketId);
    if (existing !== null) {
      return existing;
    }
    const wallet = this.strategy.select(basketId, await this.registry.listWallets());
    const candidate: WalletAssignment = Object.freeze({
      basketId,
      walletId: wallet.walletId,
      shard: wallet.shard,
      strategyVersion: this.strategy.version,
      assignedAtMs: this.clock.nowMs(),
    });
    return this.assignments.putIfAbsent(candidate);
  }
}
