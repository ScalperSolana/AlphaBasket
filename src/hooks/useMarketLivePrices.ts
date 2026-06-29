import { useEffect, useMemo, useRef, useState } from 'react';
import type { PolymarketMarket } from '@/types/polymarket.ts';

type LivePriceMap = { YES: number; NO: number };

interface AssetState {
  bestBid?: number;
  bestAsk?: number;
  lastTrade?: number;
  updatedAt: number;
}

type Listener = () => void;

const MARKET_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const HEARTBEAT_INTERVAL_MS = 10_000;

const assetState = new Map<string, AssetState>();
const assetListeners = new Map<string, Set<Listener>>();
const assetRefCounts = new Map<string, number>();

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let heartbeatTimer: number | null = null;
let reconnectAttempt = 0;

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearHeartbeatTimer() {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  if (typeof window === 'undefined') return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (heartbeatTimer !== null) return;

  heartbeatTimer = window.setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearHeartbeatTimer();
      return;
    }

    ws.send('PING');
  }, HEARTBEAT_INTERVAL_MS);
}

function ensureSocket() {
  if (typeof window === 'undefined') return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (assetRefCounts.size === 0) return;

  ws = new WebSocket(MARKET_WS_URL);

  ws.addEventListener('open', () => {
    reconnectAttempt = 0;
    clearHeartbeatTimer();
    startHeartbeat();
    const assetIds = [...assetRefCounts.keys()];
    if (assetIds.length > 0) {
      ws?.send(JSON.stringify({
        assets_ids: assetIds,
        type: 'market',
        custom_feature_enabled: true,
      }));
    }
  });

  ws.addEventListener('message', (event) => {
    let parsed: any;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }

    const updates = Array.isArray(parsed) ? parsed : [parsed];
    for (const update of updates) {
      const eventType = update?.event_type;
      if (eventType === 'price_change' && Array.isArray(update?.price_changes)) {
        for (const change of update.price_changes) {
          const assetId = String(change?.asset_id || '');
          if (!assetId) continue;
          const state = assetState.get(assetId) ?? { updatedAt: 0 };
          const bestBid = Number.parseFloat(change?.best_bid ?? '');
          const bestAsk = Number.parseFloat(change?.best_ask ?? '');
          if (Number.isFinite(bestBid) && bestBid >= 0) state.bestBid = bestBid;
          if (Number.isFinite(bestAsk) && bestAsk >= 0) state.bestAsk = bestAsk;
          state.updatedAt = Number.parseInt(String(update?.timestamp || Date.now()), 10) || Date.now();
          assetState.set(assetId, state);
          assetListeners.get(assetId)?.forEach((listener) => listener());
        }
        continue;
      }

      const assetIdRaw = update?.asset_id;
      if (!assetIdRaw) continue;
      const assetId = String(assetIdRaw);
      const state = assetState.get(assetId) ?? { updatedAt: 0 };

      if (eventType === 'best_bid_ask') {
        const bestBid = Number.parseFloat(update?.best_bid ?? '');
        const bestAsk = Number.parseFloat(update?.best_ask ?? '');
        if (Number.isFinite(bestBid) && bestBid >= 0) state.bestBid = bestBid;
        if (Number.isFinite(bestAsk) && bestAsk >= 0) state.bestAsk = bestAsk;
      } else if (eventType === 'last_trade_price') {
        const lastTrade = Number.parseFloat(update?.price ?? '');
        if (Number.isFinite(lastTrade) && lastTrade >= 0) state.lastTrade = lastTrade;
      } else if (eventType === 'book') {
        const bid = Number.parseFloat(update?.bids?.[0]?.price ?? '');
        const ask = Number.parseFloat(update?.asks?.[0]?.price ?? '');
        if (Number.isFinite(bid) && bid >= 0) state.bestBid = bid;
        if (Number.isFinite(ask) && ask >= 0) state.bestAsk = ask;
      }

      state.updatedAt = Number.parseInt(String(update?.timestamp || Date.now()), 10) || Date.now();
      assetState.set(assetId, state);
      assetListeners.get(assetId)?.forEach((listener) => listener());
    }
  });

  ws.addEventListener('close', () => {
    clearHeartbeatTimer();
    ws = null;
    if (assetRefCounts.size === 0) return;
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 10000);
    reconnectAttempt += 1;
    clearReconnectTimer();
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      ensureSocket();
    }, delay);
  });

  ws.addEventListener('error', () => {
    ws?.close();
  });
}

function releaseSocketIfUnused() {
  if (assetRefCounts.size > 0) return;
  clearReconnectTimer();
  clearHeartbeatTimer();
  if (ws) {
    ws.close();
    ws = null;
  }
}

function subscribeAsset(assetId: string, listener: Listener) {
  const set = assetListeners.get(assetId) ?? new Set<Listener>();
  set.add(listener);
  assetListeners.set(assetId, set);
  assetRefCounts.set(assetId, (assetRefCounts.get(assetId) ?? 0) + 1);

  const wasClosed = !ws || ws.readyState !== WebSocket.OPEN;
  ensureSocket();

  if (!wasClosed && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      assets_ids: [assetId],
      type: 'market',
      custom_feature_enabled: true,
    }));
  }

  return () => {
    const listenersForAsset = assetListeners.get(assetId);
    listenersForAsset?.delete(listener);
    if (listenersForAsset && listenersForAsset.size === 0) {
      assetListeners.delete(assetId);
    }

    const remaining = (assetRefCounts.get(assetId) ?? 1) - 1;
    if (remaining <= 0) {
      assetRefCounts.delete(assetId);
    } else {
      assetRefCounts.set(assetId, remaining);
    }

    releaseSocketIfUnused();
  };
}

function deriveTokenPrice(state: AssetState | undefined): number | null {
  if (!state) return null;
  if (Number.isFinite(state.bestBid) && Number.isFinite(state.bestAsk) && state.bestBid! >= 0 && state.bestAsk! >= 0) {
    return (state.bestBid! + state.bestAsk!) / 2;
  }
  if (Number.isFinite(state.lastTrade) && state.lastTrade! >= 0) {
    return state.lastTrade!;
  }
  if (Number.isFinite(state.bestBid) && state.bestBid! >= 0) return state.bestBid!;
  if (Number.isFinite(state.bestAsk) && state.bestAsk! >= 0) return state.bestAsk!;
  return null;
}

export function useMarketLivePrices(market: PolymarketMarket | undefined): LivePriceMap | null {
  const assetIds = useMemo(() => {
    const ids = market?.clobTokenIds?.filter(Boolean).map(String) ?? [];
    return ids.slice(0, 2);
  }, [market?.clobTokenIds]);

  const [version, setVersion] = useState(0);
  const lastValueRef = useRef<LivePriceMap | null>(null);

  useEffect(() => {
    if (assetIds.length < 2) return;
    const rerender = () => setVersion((v) => v + 1);
    const unsubs = assetIds.map((assetId) => subscribeAsset(assetId, rerender));
    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, [assetIds]);

  return useMemo(() => {
    if (assetIds.length < 2) return null;
    const yes = deriveTokenPrice(assetState.get(assetIds[0]));
    const no = deriveTokenPrice(assetState.get(assetIds[1]));
    if (yes == null || no == null) {
      return lastValueRef.current;
    }
    const next = { YES: yes, NO: no };
    lastValueRef.current = next;
    return next;
  }, [assetIds, version]);
}

export function useMarketsLivePrices(markets: Array<PolymarketMarket | null | undefined>): Map<string, LivePriceMap> {
  const marketAssets = useMemo(() => {
    return markets
      .map((market) => {
        const assetIds = market?.clobTokenIds?.filter(Boolean).map(String).slice(0, 2) ?? [];
        if (!market?.id || assetIds.length < 2) {
          return null;
        }

        return {
          marketId: market.id,
          assetIds,
        };
      })
      .filter((entry): entry is { marketId: string; assetIds: string[] } => entry !== null);
  }, [markets]);

  const subscriptionAssetIds = useMemo(
    () => Array.from(new Set(marketAssets.flatMap((entry) => entry.assetIds))),
    [marketAssets],
  );
  const subscriptionKey = useMemo(() => subscriptionAssetIds.join(','), [subscriptionAssetIds]);

  const [version, setVersion] = useState(0);
  const lastValuesRef = useRef(new Map<string, LivePriceMap>());

  useEffect(() => {
    if (subscriptionAssetIds.length === 0) return;

    const rerender = () => setVersion((v) => v + 1);
    const unsubs = subscriptionAssetIds.map((assetId) => subscribeAsset(assetId, rerender));

    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, [subscriptionAssetIds, subscriptionKey]);

  return useMemo(() => {
    const next = new Map<string, LivePriceMap>();
    const activeMarketIds = new Set<string>();

    for (const { marketId, assetIds } of marketAssets) {
      activeMarketIds.add(marketId);
      const yes = deriveTokenPrice(assetState.get(assetIds[0]));
      const no = deriveTokenPrice(assetState.get(assetIds[1]));

      if (yes == null || no == null) {
        const lastValue = lastValuesRef.current.get(marketId);
        if (lastValue) {
          next.set(marketId, lastValue);
        }
        continue;
      }

      const current = { YES: yes, NO: no };
      lastValuesRef.current.set(marketId, current);
      next.set(marketId, current);
    }

    for (const marketId of [...lastValuesRef.current.keys()]) {
      if (!activeMarketIds.has(marketId)) {
        lastValuesRef.current.delete(marketId);
      }
    }

    return next;
  }, [marketAssets, version]);
}
