import { useEffect, useMemo, useState } from 'react';
import type { PolymarketMarket } from '@/types/polymarket.ts';
import { fmtCryptoPrice } from '@/hooks/useCryptoPrice';

const ASSET_ALIASES: Array<{ asset: string; patterns: RegExp[] }> = [
  { asset: 'btc', patterns: [/\bbitcoin\b/i, /\bbtc\b/i] },
  { asset: 'eth', patterns: [/\bethereum\b/i, /\beth\b/i] },
  { asset: 'sol', patterns: [/\bsolana\b/i, /\bsol\b/i] },
  { asset: 'xrp', patterns: [/\bxrp\b/i, /\bripple\b/i] },
  { asset: 'doge', patterns: [/\bdogecoin\b/i, /\bdoge\b/i] },
  { asset: 'hype', patterns: [/\bhyperliquid\b/i, /\bhype\b/i] },
  { asset: 'bnb', patterns: [/\bbnb\b/i, /\bbinance coin\b/i, /\bbinance\b/i] },
];

const BINANCE_SYMBOLS: Record<string, string> = {
  btc: 'BTCUSDT',
  eth: 'ETHUSDT',
  sol: 'SOLUSDT',
  xrp: 'XRPUSDT',
  doge: 'DOGEUSDT',
  hype: 'HYPEUSDT',
  bnb: 'BNBUSDT',
};

const COINGECKO_IDS: Record<string, string> = {
  hype: 'hyperliquid',
};

const priceCache = new Map<string, string>();

function detectAsset(text: string): string | null {
  for (const { asset, patterns } of ASSET_ALIASES) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return asset;
    }
  }
  return null;
}

function parseClockToMinutes(value: string): number | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(AM|PM)$/i);
  if (!match) return null;
  let hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const meridiem = match[3].toUpperCase();
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  if (hours === 12) hours = 0;
  if (meridiem === 'PM') hours += 12;
  return hours * 60 + minutes;
}

function extractWindowDurationMinutes(question: string): number | null {
  const match = question.match(/(\d{1,2}:\d{2}(?:AM|PM))\s*-\s*(\d{1,2}:\d{2}(?:AM|PM))\s*ET/i);
  if (!match) return null;
  const start = parseClockToMinutes(match[1]);
  const end = parseClockToMinutes(match[2]);
  if (start == null || end == null) return null;
  const delta = end - start;
  if (delta > 0) return delta;
  if (delta < 0) return delta + 24 * 60;
  return null;
}

function deriveStartTimestamp(market: PolymarketMarket): number | null {
  const durationMinutes = extractWindowDurationMinutes(market.question || '');

  if (durationMinutes && market.endDate) {
    const endTs = new Date(market.endDate).getTime();
    if (Number.isFinite(endTs)) {
      return endTs - durationMinutes * 60_000;
    }
  }

  for (const candidate of [market.gameStartTime, market.startDate]) {
    if (!candidate) continue;
    const ts = new Date(candidate).getTime();
    if (Number.isFinite(ts)) {
      return ts;
    }
  }

  return null;
}

async function fetchPriceToBeat(asset: string, symbol: string, startTimestamp: number): Promise<number | null> {
  const tradeWindowEnd = startTimestamp + 60_000;
  const tradeUrl = `https://api.binance.com/api/v3/aggTrades?symbol=${symbol}&startTime=${startTimestamp}&endTime=${tradeWindowEnd}&limit=1`;
  const tradeRes = await fetch(tradeUrl, { signal: AbortSignal.timeout(8000) });
  if (tradeRes.ok) {
    const trades = await tradeRes.json();
    if (Array.isArray(trades) && trades.length > 0) {
      const firstPrice = Number.parseFloat(trades[0]?.p ?? '');
      if (Number.isFinite(firstPrice)) return firstPrice;
    }
  }

  const minuteStart = Math.floor(startTimestamp / 60_000) * 60_000;
  const klineUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${minuteStart}&limit=1`;
  const klineRes = await fetch(klineUrl, { signal: AbortSignal.timeout(8000) });
  if (klineRes.ok) {
    const klines = await klineRes.json();
    if (Array.isArray(klines) && klines.length > 0 && Array.isArray(klines[0])) {
      const open = Number.parseFloat(klines[0][1] ?? '');
      if (Number.isFinite(open)) return open;
    }
  }

  const coinId = COINGECKO_IDS[asset];
  if (!coinId) return null;

  const fromSeconds = Math.floor((startTimestamp - 300_000) / 1000);
  const toSeconds = Math.ceil((startTimestamp + 300_000) / 1000);
  const cgUrl = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/market_chart/range?vs_currency=usd&from=${fromSeconds}&to=${toSeconds}`;
  const cgRes = await fetch(cgUrl, { signal: AbortSignal.timeout(8000) });
  if (!cgRes.ok) return null;
  const cgData = await cgRes.json();
  const prices = Array.isArray(cgData?.prices) ? cgData.prices : [];
  if (prices.length === 0) return null;

  let nearest: [number, number] | null = null;
  for (const row of prices) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const ts = typeof row[0] === 'number' ? row[0] : Number.NaN;
    const price = typeof row[1] === 'number' ? row[1] : Number.NaN;
    if (!Number.isFinite(ts) || !Number.isFinite(price)) continue;
    if (ts >= startTimestamp) {
      nearest = [ts, price];
      break;
    }
    nearest = [ts, price];
  }

  return nearest?.[1] ?? null;
}

export function usePriceToBeat(market: PolymarketMarket | undefined): string | null {
  const explicit = market?.priceToBeat ?? null;
  const derivedContext = useMemo(() => {
    if (!market || explicit) return null;
    const asset = detectAsset(`${market.question || ''}\n${market.description || ''}`.toLowerCase());
    const symbol = asset ? BINANCE_SYMBOLS[asset] ?? null : null;
    const startTimestamp = market ? deriveStartTimestamp(market) : null;
    if (!symbol || !startTimestamp) return null;
    return { asset, symbol, startTimestamp };
  }, [market, explicit]);

  const [value, setValue] = useState<string | null>(explicit);

  useEffect(() => {
    if (explicit) {
      setValue(explicit);
      return;
    }
    if (!market || !derivedContext) {
      setValue(null);
      return;
    }

    const cacheKey = `${market.id}:${derivedContext.symbol}:${derivedContext.startTimestamp}`;
    const cached = priceCache.get(cacheKey);
    if (cached) {
      setValue(cached);
      return;
    }

    let cancelled = false;
    fetchPriceToBeat(derivedContext.asset, derivedContext.symbol, derivedContext.startTimestamp)
      .then((price) => {
        if (cancelled || price == null) return;
        const formatted = fmtCryptoPrice(price);
        priceCache.set(cacheKey, formatted);
        setValue(formatted);
      })
      .catch(() => {
        if (!cancelled) setValue(null);
      });

    return () => {
      cancelled = true;
    };
  }, [market, explicit, derivedContext]);

  return value;
}
