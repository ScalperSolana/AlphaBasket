import { Basket, BasketDraft, BasketItem, Position, Snapshot, NetworkType } from '@/types/basket.ts';
import { netDepositUnits } from '@/lib/solana/escrowEconomics';

const BASKETS_KEY = 'polybaskets_baskets';
const FOLLOWS_KEY = 'polybaskets_follows';
const DRAFT_KEY = 'polybaskets_draft';
const POSITIONS_KEY = 'polybaskets_positions';

// Off-chain metadata cache backed by localStorage. Stakes execute on Solana
// into basket-specific USDC vaults; baskets and positions are tracked here. This layer
// is intentionally function-scoped so a backend indexer can replace it later
// without touching callers.
//
// NOTE: Solana addresses are base58 and CASE-SENSITIVE. Owner comparisons here
// use exact string equality — never lowercase a pubkey.

export function generateBasketId(): string {
  return `basket_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getBaskets(): Basket[] {
  try {
    // Check if localStorage is available
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return [];
    }
    const data = localStorage.getItem(BASKETS_KEY);
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.warn('[basket-storage] Failed to get baskets from localStorage:', error);
    return [];
  }
}

export function getBasketById(id: string): Basket | null {
  try {
    const baskets = getBaskets();
    return baskets.find(b => b.id === id) || null;
  } catch (error) {
    console.warn(`[getBasketById] Failed to get basket ${id}:`, error);
    return null;
  }
}

export function deleteBasket(id: string): boolean {
  try {
    const baskets = getBaskets();
    const initialLength = baskets.length;
    const filtered = baskets.filter(b => b.id !== id);
    
    if (filtered.length < initialLength) {
      localStorage.setItem(BASKETS_KEY, JSON.stringify(filtered));
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function getBasketsByOwner(owner: string): Basket[] {
  if (!owner) {
    console.warn('[getBasketsByOwner] No owner address provided');
    return [];
  }
  try {
    const baskets = getBaskets();
    // base58 pubkeys are case-sensitive — exact equality only.
    return baskets.filter(b => (b.owner || '') === owner);
  } catch (error) {
    console.warn('[getBasketsByOwner] Failed to get baskets by owner:', error);
    return [];
  }
}

export function createBasket(
  draft: BasketDraft,
  owner: string,
  network: NetworkType,
  snapshot: Snapshot
): Basket {
  const baskets = getBaskets();
  
  const newBasket: Basket = {
    id: generateBasketId(),
    owner,
    name: draft.name,
    description: draft.description,
    tags: draft.tags,
    createdAt: Date.now(),
    items: draft.items,
    createdSnapshot: snapshot,
    network,
  };

  baskets.push(newBasket);
  localStorage.setItem(BASKETS_KEY, JSON.stringify(baskets));

  return newBasket;
}

/** Insert or replace a fully-formed basket (used by the create-and-stake flow). */
export function saveBasket(basket: Basket): void {
  const baskets = getBaskets();
  const idx = baskets.findIndex(b => b.id === basket.id);
  if (idx >= 0) {
    baskets[idx] = basket;
  } else {
    baskets.push(basket);
  }
  localStorage.setItem(BASKETS_KEY, JSON.stringify(baskets));
}

// Follows
export function getFollows(userAddress: string): string[] {
  try {
    // Check if localStorage is available
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return [];
    }
    const data = localStorage.getItem(FOLLOWS_KEY);
    const allFollows: Record<string, string[]> = data ? JSON.parse(data) : {};
    return allFollows[userAddress.toLowerCase()] || [];
  } catch (error) {
    console.warn('[getFollows] Failed to get follows from localStorage:', error);
    return [];
  }
}

export function getFollowerCount(basketId: string): number {
  try {
    const data = localStorage.getItem(FOLLOWS_KEY);
    const allFollows: Record<string, string[]> = data ? JSON.parse(data) : {};
    
    let count = 0;
    Object.values(allFollows).forEach(follows => {
      if (follows.includes(basketId)) count++;
    });
    return count;
  } catch {
    return 0;
  }
}

export function followBasket(userAddress: string, basketId: string): void {
  const data = localStorage.getItem(FOLLOWS_KEY);
  const allFollows: Record<string, string[]> = data ? JSON.parse(data) : {};
  
  const userFollows = allFollows[userAddress.toLowerCase()] || [];
  if (!userFollows.includes(basketId)) {
    userFollows.push(basketId);
    allFollows[userAddress.toLowerCase()] = userFollows;
    localStorage.setItem(FOLLOWS_KEY, JSON.stringify(allFollows));
  }
}

export function unfollowBasket(userAddress: string, basketId: string): void {
  const data = localStorage.getItem(FOLLOWS_KEY);
  const allFollows: Record<string, string[]> = data ? JSON.parse(data) : {};
  
  const userFollows = allFollows[userAddress.toLowerCase()] || [];
  const index = userFollows.indexOf(basketId);
  if (index > -1) {
    userFollows.splice(index, 1);
    allFollows[userAddress.toLowerCase()] = userFollows;
    localStorage.setItem(FOLLOWS_KEY, JSON.stringify(allFollows));
  }
}

export function isFollowing(userAddress: string, basketId: string): boolean {
  const follows = getFollows(userAddress);
  return follows.includes(basketId);
}

// Draft management
export function saveDraft(draft: BasketDraft): void {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

export function getDraft(): BasketDraft | null {
  try {
    const data = localStorage.getItem(DRAFT_KEY);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  localStorage.removeItem(DRAFT_KEY);
}

// Positions (off-chain bet ledger)
export function getPositions(): Position[] {
  try {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return [];
    }
    const data = localStorage.getItem(POSITIONS_KEY);
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.warn('[basket-storage] Failed to get positions from localStorage:', error);
    return [];
  }
}

export function addPosition(position: Position): void {
  const positions = getPositions();
  // Both transaction call sites provide the gross amount sent by the wallet.
  // Store the post-fee principal so local PnL mirrors the on-chain Position.
  const netStake = netDepositUnits(BigInt(position.stakeUsdcUnits));
  positions.push({ ...position, stakeUsdcUnits: netStake.toString() });
  localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
}

export function getPositionsByOwner(owner: string): Position[] {
  if (!owner) return [];
  // base58 pubkeys are case-sensitive — exact equality only.
  return getPositions().filter(p => p.owner === owner);
}

export function getPositionsForBasket(basketId: string): Position[] {
  return getPositions().filter(p => p.basketId === basketId);
}

/**
 * A wallet's aggregated position in a basket (positions accumulate per stake).
 * Returns null when the wallet has no stake in the basket.
 */
export function getOwnerPositionForBasket(owner: string, basketId: string): Position | null {
  if (!owner) return null;
  const matches = getPositions().filter(p => p.owner === owner && p.basketId === basketId);
  if (matches.length === 0) return null;

  // Collapse multiple stakes into a single view (sum stakes, keep earliest entry index).
  const totalUnits = matches.reduce((sum, p) => sum + BigInt(p.stakeUsdcUnits), 0n);
  const earliest = matches.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
  return {
    ...earliest,
    stakeUsdcUnits: totalUnits.toString(),
    claimed: matches.every(p => p.claimed),
  };
}

export function markPositionsClaimRequested(owner: string, basketId: string): void {
  const positions = getPositions();
  const now = Date.now();
  let changed = false;
  positions.forEach(p => {
    if (p.owner === owner && p.basketId === basketId && !p.claimed && !p.claimRequestedAt) {
      p.claimRequestedAt = now;
      changed = true;
    }
  });
  if (changed) {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  }
}
