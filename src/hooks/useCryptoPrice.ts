import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { PolymarketMarket } from '@/types/polymarket.ts';

type FeedTopic = 'crypto_prices' | 'crypto_prices_chainlink';
type FeedSource = 'polymarket-binance' | 'polymarket-chainlink' | 'binance-direct' | 'coingecko-direct';

interface FeedSubscription {
  topic: FeedTopic;
  type: 'update' | '*';
  filter: string;
  source: FeedSource;
  symbol: string;
  asset: string;
}

interface LivePriceSnapshot {
  price: number;
  timestamp: number;
  source: FeedSource;
  symbol: string;
  asset: string;
}

interface CryptoPriceData {
  price: number | null;
  prevPrice: number | null;
  direction: 'up' | 'down' | null;
  source: FeedSource | null;
  symbol: string | null;
  updatedAt: number | null;
  isLive: boolean;
}

const ASSET_ALIASES: Array<{ asset: string; patterns: RegExp[] }> = [
  { asset: 'btc', patterns: [/\bbitcoin\b/i, /\bbtc\b/i] },
  { asset: 'eth', patterns: [/\bethereum\b/i, /\beth\b/i] },
  { asset: 'sol', patterns: [/\bsolana\b/i, /\bsol\b/i] },
  { asset: 'xrp', patterns: [/\bxrp\b/i, /\bripple\b/i] },
  { asset: 'doge', patterns: [/\bdogecoin\b/i, /\bdoge\b/i] },
  { asset: 'hype', patterns: [/\bhyperliquid\b/i, /\bhype\b/i] },
  { asset: 'bnb', patterns: [/\bbnb\b/i, /\bbinance coin\b/i, /\bbinance\b/i] },
];

const FALLBACK_BINANCE_SYMBOLS: Record<string, string> = {
  btc: 'btcusdt',
  eth: 'ethusdt',
  sol: 'solusdt',
  xrp: 'xrpusdt',
  doge: 'dogeusdt',
  hype: 'hypeusdt',
  bnb: 'bnbusdt',
};

const FALLBACK_CHAINLINK_SYMBOLS: Record<string, string> = {
  btc: 'btc/usd',
  eth: 'eth/usd',
  sol: 'sol/usd',
  xrp: 'xrp/usd',
  doge: 'doge/usd',
  hype: 'hype/usd',
};

const COINGECKO_IDS: Record<string, string> = {
  hype: 'hyperliquid',
};

const DEFAULT_RTD_ASSETS = new Set(['btc', 'eth', 'sol', 'xrp']);

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws';
const BINANCE_FALLBACK_DELAY_MS = 1500;
const COINGECKO_POLL_MS = 2500;

type Listener = (snapshot: LivePriceSnapshot) => void;

const priceCache = new Map<string, LivePriceSnapshot>();
const listeners = new Map<string, Set<Listener>>();
const subscriptionRefCounts = new Map<string, number>();
const subscriptionConfigs = new Map<string, FeedSubscription>();

let ws: WebSocket | null = null;
let pingTimer: number | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;

const binancePriceCache = new Map<string, LivePriceSnapshot>();
const binanceListeners = new Map<string, Set<Listener>>();
const binanceRefCounts = new Map<string, number>();
const binanceSockets = new Map<string, WebSocket>();
const coingeckoPriceCache = new Map<string, LivePriceSnapshot>();
const coingeckoListeners = new Map<string, Set<Listener>>();
const coingeckoRefCounts = new Map<string, number>();
const coingeckoTimers = new Map<string, number>();

async function pollCoinGeckoPrice(asset: string, coinId: string) {
  const response = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd&include_last_updated_at=true`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!response.ok) return;
  const data = await response.json();
  const entry = data?.[coinId];
  const price = typeof entry?.usd === 'number' ? entry.usd : Number.NaN;
  const lastUpdatedAt = typeof entry?.last_updated_at === 'number' ? entry.last_updated_at * 1000 : Date.now();
  if (!Number.isFinite(price)) return;

  const snapshot: LivePriceSnapshot = {
    price,
    timestamp: Number.isFinite(lastUpdatedAt) ? lastUpdatedAt : Date.now(),
    source: 'coingecko-direct',
    symbol: coinId,
    asset,
  };

  coingeckoPriceCache.set(asset, snapshot);
  coingeckoListeners.get(asset)?.forEach((fn) => fn(snapshot));
}

function getSubscriptionKey(topic: FeedTopic, symbol: string): string {
  return `${topic}:${symbol.toLowerCase()}`;
}

function clearTimers() {
  if (pingTimer !== null) {
    window.clearInterval(pingTimer);
    pingTimer = null;
  }
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function sendSubscription(action: 'subscribe' | 'unsubscribe', sub: FeedSubscription) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    action,
    subscriptions: [
      {
        topic: sub.topic,
        type: sub.type,
        filters: sub.filter,
      },
    ],
  }));
}

function startPing() {
  if (pingTimer !== null) return;
  pingTimer = window.setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send('PING');
    }
  }, 5_000);
}

function scheduleReconnect() {
  if (reconnectTimer !== null || subscriptionRefCounts.size === 0) return;
  const delay = Math.min(1_000 * 2 ** reconnectAttempt, 10_000);
  reconnectAttempt += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    ensureSocket();
  }, delay);
}

function handleMessage(event: MessageEvent<string>) {
  if (event.data === 'PONG' || event.data === 'PING') return;

  let parsed: any;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    return;
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const message of messages) {
    const topic = message?.topic as FeedTopic | undefined;
    const payload = message?.payload;
    const symbol = typeof payload?.symbol === 'string' ? payload.symbol.toLowerCase() : null;
    const rawValue = payload?.value;
    const value = typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string'
        ? Number.parseFloat(rawValue)
        : NaN;
    const rawTimestamp = payload?.timestamp ?? message?.timestamp;
    const timestamp = typeof rawTimestamp === 'number'
      ? rawTimestamp
      : typeof rawTimestamp === 'string'
        ? Number.parseInt(rawTimestamp, 10)
        : Date.now();

    if (!topic || !symbol || !Number.isFinite(value)) continue;

    const key = getSubscriptionKey(topic, symbol);
    const sub = subscriptionConfigs.get(key);
    if (!sub) continue;

    const snapshot: LivePriceSnapshot = {
      price: value,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      source: sub.source,
      symbol,
      asset: sub.asset,
    };

    priceCache.set(key, snapshot);
    listeners.get(key)?.forEach((listener) => listener(snapshot));
  }
}

function handleSocketClose() {
  ws = null;
  clearTimers();
  scheduleReconnect();
}

function ensureSocket() {
  if (typeof window === 'undefined') return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (subscriptionRefCounts.size === 0) return;

  ws = new WebSocket(RTDS_URL);

  ws.addEventListener('open', () => {
    reconnectAttempt = 0;
    startPing();
    subscriptionConfigs.forEach((sub) => sendSubscription('subscribe', sub));
  });
  ws.addEventListener('message', handleMessage);
  ws.addEventListener('close', handleSocketClose);
  ws.addEventListener('error', () => {
    ws?.close();
  });
}

function releaseSocketIfUnused() {
  if (subscriptionRefCounts.size > 0) return;
  clearTimers();
  if (ws) {
    ws.close();
    ws = null;
  }
}

function subscribeToFeed(sub: FeedSubscription, listener: Listener) {
  const key = getSubscriptionKey(sub.topic, sub.symbol);
  const currentListeners = listeners.get(key) ?? new Set<Listener>();
  currentListeners.add(listener);
  listeners.set(key, currentListeners);
  subscriptionConfigs.set(key, sub);
  subscriptionRefCounts.set(key, (subscriptionRefCounts.get(key) ?? 0) + 1);

  ensureSocket();
  if (ws?.readyState === WebSocket.OPEN && subscriptionRefCounts.get(key) === 1) {
    sendSubscription('subscribe', sub);
  }

  const cached = priceCache.get(key);
  if (cached) {
    listener(cached);
  }

  return () => {
    const current = listeners.get(key);
    current?.delete(listener);
    if (current && current.size === 0) {
      listeners.delete(key);
    }

    const remaining = (subscriptionRefCounts.get(key) ?? 1) - 1;
    if (remaining <= 0) {
      subscriptionRefCounts.delete(key);
      if (ws?.readyState === WebSocket.OPEN) {
        sendSubscription('unsubscribe', sub);
      }
      subscriptionConfigs.delete(key);
    } else {
      subscriptionRefCounts.set(key, remaining);
    }

    releaseSocketIfUnused();
  };
}

function detectAsset(text: string): string | null {
  for (const { asset, patterns } of ASSET_ALIASES) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return asset;
    }
  }
  return null;
}

function subscribeToBinanceSymbol(asset: string, symbol: string, listener: Listener) {
  const normalizedSymbol = symbol.toLowerCase();
  const currentListeners = binanceListeners.get(normalizedSymbol) ?? new Set<Listener>();
  currentListeners.add(listener);
  binanceListeners.set(normalizedSymbol, currentListeners);
  binanceRefCounts.set(normalizedSymbol, (binanceRefCounts.get(normalizedSymbol) ?? 0) + 1);

  let socket = binanceSockets.get(normalizedSymbol);
  if (!socket || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) {
    socket = new WebSocket(`${BINANCE_WS_BASE}/${normalizedSymbol}@trade`);
    socket.addEventListener('message', (event) => {
      let parsed: any;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }

      const rawPrice = parsed?.p;
      const rawTimestamp = parsed?.T ?? parsed?.E;
      const price = typeof rawPrice === 'string' ? Number.parseFloat(rawPrice) : Number.NaN;
      const timestamp = typeof rawTimestamp === 'number'
        ? rawTimestamp
        : typeof rawTimestamp === 'string'
          ? Number.parseInt(rawTimestamp, 10)
          : Date.now();
      if (!Number.isFinite(price)) return;

      const snapshot: LivePriceSnapshot = {
        price,
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        source: 'binance-direct',
        symbol: normalizedSymbol,
        asset,
      };
      binancePriceCache.set(normalizedSymbol, snapshot);
      binanceListeners.get(normalizedSymbol)?.forEach((fn) => fn(snapshot));
    });
    socket.addEventListener('close', () => {
      binanceSockets.delete(normalizedSymbol);
    });
    socket.addEventListener('error', () => {
      socket?.close();
    });
    binanceSockets.set(normalizedSymbol, socket);
  }

  const cached = binancePriceCache.get(normalizedSymbol);
  if (cached) {
    listener(cached);
  }

  return () => {
    const listenersForSymbol = binanceListeners.get(normalizedSymbol);
    listenersForSymbol?.delete(listener);
    if (listenersForSymbol && listenersForSymbol.size === 0) {
      binanceListeners.delete(normalizedSymbol);
    }

    const remaining = (binanceRefCounts.get(normalizedSymbol) ?? 1) - 1;
    if (remaining <= 0) {
      binanceRefCounts.delete(normalizedSymbol);
      const openSocket = binanceSockets.get(normalizedSymbol);
      if (openSocket) {
        openSocket.close();
        binanceSockets.delete(normalizedSymbol);
      }
    } else {
      binanceRefCounts.set(normalizedSymbol, remaining);
    }
  };
}

function subscribeToCoinGeckoAsset(asset: string, coinId: string, listener: Listener) {
  const currentListeners = coingeckoListeners.get(asset) ?? new Set<Listener>();
  currentListeners.add(listener);
  coingeckoListeners.set(asset, currentListeners);
  coingeckoRefCounts.set(asset, (coingeckoRefCounts.get(asset) ?? 0) + 1);

  const cached = coingeckoPriceCache.get(asset);
  if (cached) {
    listener(cached);
  }

  if (!coingeckoTimers.has(asset)) {
    const run = () => {
      pollCoinGeckoPrice(asset, coinId).catch(() => {});
    };
    run();
    const timer = window.setInterval(run, COINGECKO_POLL_MS);
    coingeckoTimers.set(asset, timer);
  }

  return () => {
    const listenersForAsset = coingeckoListeners.get(asset);
    listenersForAsset?.delete(listener);
    if (listenersForAsset && listenersForAsset.size === 0) {
      coingeckoListeners.delete(asset);
    }

    const remaining = (coingeckoRefCounts.get(asset) ?? 1) - 1;
    if (remaining <= 0) {
      coingeckoRefCounts.delete(asset);
      const timer = coingeckoTimers.get(asset);
      if (timer != null) {
        window.clearInterval(timer);
        coingeckoTimers.delete(asset);
      }
    } else {
      coingeckoRefCounts.set(asset, remaining);
    }
  };
}

function makeBinanceSubscription(asset: string, symbol: string): FeedSubscription {
  return {
    topic: 'crypto_prices',
    type: 'update',
    filter: symbol,
    source: 'polymarket-binance',
    symbol,
    asset,
  };
}

function makeChainlinkSubscription(asset: string, symbol: string): FeedSubscription {
  return {
    topic: 'crypto_prices_chainlink',
    type: '*',
    filter: JSON.stringify({ symbol }),
    source: 'polymarket-chainlink',
    symbol,
    asset,
  };
}

function inferFeedSubscriptions(market: PolymarketMarket): FeedSubscription[] {
  const question = market.question || '';
  const description = market.description || '';
  const combined = `${question}\n${description}\n${market.groupItemTitle || ''}`;
  const combinedLower = combined.toLowerCase();
  const asset = detectAsset(combinedLower);
  if (!asset) return [];

  const explicitPair = combined.match(/\b(BTC|ETH|SOL|XRP|DOGE|HYPE)\s*\/\s*(USD|USDT)\b/i);
  const mentionsChainlink = /chainlink/i.test(combined);
  const mentionsBinance = /binance/i.test(combined);

  if (explicitPair) {
    const base = explicitPair[1].toLowerCase();
    const quote = explicitPair[2].toLowerCase();
    if (quote === 'usd') {
      return [makeChainlinkSubscription(asset, `${base}/usd`)];
    }
    return [makeBinanceSubscription(asset, `${base}${quote}`)];
  }

  if (mentionsChainlink) {
    const symbol = FALLBACK_CHAINLINK_SYMBOLS[asset];
    return symbol ? [makeChainlinkSubscription(asset, symbol)] : [];
  }

  if (mentionsBinance) {
    const symbol = FALLBACK_BINANCE_SYMBOLS[asset];
    return symbol ? [makeBinanceSubscription(asset, symbol)] : [];
  }

  if (!DEFAULT_RTD_ASSETS.has(asset)) {
    return [];
  }

  const defaultBinanceSymbol = FALLBACK_BINANCE_SYMBOLS[asset];
  const defaultChainlinkSymbol = FALLBACK_CHAINLINK_SYMBOLS[asset];
  const subscriptions: FeedSubscription[] = [];
  if (defaultBinanceSymbol) subscriptions.push(makeBinanceSubscription(asset, defaultBinanceSymbol));
  if (defaultChainlinkSymbol) subscriptions.push(makeChainlinkSubscription(asset, defaultChainlinkSymbol));
  return subscriptions;
}

export function fmtCryptoPrice(p: number): string {
  if (p >= 10_000) return `$${p.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (p >= 100) return `$${p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (p >= 1) return `$${p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(6)}`;
}

export function formatPriceTimestamp(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function useCryptoPrice(market: PolymarketMarket | undefined): CryptoPriceData {
  const subscriptions = useMemo(
    () => (market ? inferFeedSubscriptions(market) : []),
    [market]
  );
  const asset = useMemo(() => {
    if (!market) return null;
    return detectAsset(`${market.question || ''}\n${market.description || ''}\n${market.groupItemTitle || ''}`.toLowerCase());
  }, [market]);
  const binanceFallbackSymbol = asset ? FALLBACK_BINANCE_SYMBOLS[asset] ?? null : null;
  const coingeckoCoinId = asset ? COINGECKO_IDS[asset] ?? null : null;

  const [price, setPrice] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [source, setSource] = useState<FeedSource | null>(null);
  const [symbol, setSymbol] = useState<string | null>(subscriptions[0]?.symbol ?? null);
  const [isLive, setIsLive] = useState(false);
  const prevRef = useRef<number | null>(null);
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);
  const latestTimestampRef = useRef<number>(0);
  const hasPolymarketTickRef = useRef(false);

  const applySnapshot = useCallback((snapshot: LivePriceSnapshot) => {
    setPrice((prev) => {
      if (prev !== null && prev !== snapshot.price) {
        prevRef.current = prev;
        setDirection(snapshot.price > prev ? 'up' : snapshot.price < prev ? 'down' : null);
      }
      return snapshot.price;
    });
    setUpdatedAt(snapshot.timestamp);
    setSource(snapshot.source);
    setSymbol(snapshot.symbol);
    setIsLive(true);
  }, []);

  useEffect(() => {
    setPrice(null);
    setUpdatedAt(null);
    setSource(null);
    setSymbol(subscriptions[0]?.symbol ?? null);
    setIsLive(false);
    prevRef.current = null;
    latestTimestampRef.current = 0;
    hasPolymarketTickRef.current = false;
    setDirection(null);
  }, [subscriptions.map((s) => `${s.topic}:${s.symbol}`).join('|')]);

  useEffect(() => {
    if (subscriptions.length === 0) return;
    const unsubs = subscriptions.map((sub) =>
      subscribeToFeed(sub, (snapshot) => {
        const isNewer = snapshot.timestamp >= latestTimestampRef.current;
        if (!isNewer) return;
        hasPolymarketTickRef.current = true;
        latestTimestampRef.current = Math.max(latestTimestampRef.current, snapshot.timestamp);
        applySnapshot(snapshot);
      })
    );
    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, [subscriptions, applySnapshot, source]);

  useEffect(() => {
    if (!binanceFallbackSymbol) return;

    let unsubscribe: (() => void) | undefined;
    const timeout = window.setTimeout(() => {
      if (hasPolymarketTickRef.current) return;
      unsubscribe = subscribeToBinanceSymbol(asset || binanceFallbackSymbol, binanceFallbackSymbol, (snapshot) => {
        if (hasPolymarketTickRef.current) return;
        if (snapshot.timestamp < latestTimestampRef.current) return;
        latestTimestampRef.current = snapshot.timestamp;
        applySnapshot(snapshot);
      });
    }, BINANCE_FALLBACK_DELAY_MS);

    return () => {
      window.clearTimeout(timeout);
      unsubscribe?.();
    };
  }, [asset, binanceFallbackSymbol, applySnapshot]);

  useEffect(() => {
    if (!asset || !coingeckoCoinId) return;

    let unsubscribe: (() => void) | undefined;
    const timeout = window.setTimeout(() => {
      if (hasPolymarketTickRef.current) return;
      unsubscribe = subscribeToCoinGeckoAsset(asset, coingeckoCoinId, (snapshot) => {
        if (hasPolymarketTickRef.current) return;
        if (snapshot.timestamp < latestTimestampRef.current) return;
        latestTimestampRef.current = snapshot.timestamp;
        applySnapshot(snapshot);
      });
    }, BINANCE_FALLBACK_DELAY_MS);

    return () => {
      window.clearTimeout(timeout);
      unsubscribe?.();
    };
  }, [asset, coingeckoCoinId, applySnapshot]);

  useEffect(() => {
    if (!direction) return;
    const t = window.setTimeout(() => setDirection(null), 1_500);
    return () => window.clearTimeout(t);
  }, [direction, price]);

  return {
    price,
    prevPrice: prevRef.current,
    direction,
    source,
    symbol,
    updatedAt,
    isLive,
  };
}
