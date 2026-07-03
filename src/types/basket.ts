export type Outcome = 'YES' | 'NO';

export interface BasketItem {
  marketId: string;
  slug: string;
  question: string;
  outcome: Outcome;
  weightBps: number; // 0-10000 (basis points)
  currentProb?: number; // 0-1
  endTimestamp?: number;
}

export interface Snapshot {
  timestamp: number;
  basketIndex: number; // 0-1
  components: Array<{
    itemIndex: number;
    prob: number;
  }>;
}

export interface Basket {
  id: string;
  owner: string;
  name: string;
  description: string;
  tags: string[];
  createdAt: number;
  items: BasketItem[];
  createdSnapshot: Snapshot;
  network: NetworkType;
  status?: BasketStatus;
  assetKind?: BasketAssetKind;
}

export type BasketAssetKind = 'USDC';
export type BasketStatus = 'Active' | 'SettlementPending' | 'Settled';

export interface BasketDraft {
  items: BasketItem[];
  name: string;
  description: string;
  tags: string[];
}

export type NetworkType = 'solana';

export interface NetworkConfig {
  id: NetworkType;
  name: string;
  cluster: 'devnet' | 'testnet' | 'mainnet-beta';
  rpcUrl: string;
  /** Protocol treasury wallet (base58) that receives escrow fees. */
  treasury: string;
  explorerBase: string;
}

/**
 * An off-chain position metadata view. Net stakes are held in a basket-specific
 * escrow vault (localStorage metadata now, indexer later).
 */
export interface Position {
  basketId: string;
  owner: string;
  /** Net post-deposit-fee stake in USDC base units, serialized as a string. */
  stakeUsdcUnits: string;
  /** Basket index at the moment of staking, in basis points (1-10000). */
  indexAtCreationBps: number;
  /** Solana transaction signature of the stake transfer. */
  txSignature: string;
  createdAt: number;
  claimed: boolean;
  claimRequestedAt?: number;
}

export interface CuratorEntry {
  address: string;
  totalFollowers: number;
  basketCount: number;
}
