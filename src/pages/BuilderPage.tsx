import '@/styles/legacy-effects.css';
import { useMemo, useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useBasket } from '@/contexts/BasketContext';
import { useQuery } from '@tanstack/react-query';
import { searchMarkets, getOutcomeProbabilities, getOutcomePrices, getMarketDetails } from '@/lib/polymarket.ts';
import { OutcomeProbabilities, PolymarketMarket } from '@/types/polymarket.ts';
import { BasketBuilder } from '@/components/BasketBuilder';
import { BasketIndex } from '@/components/BasketIndex';
import { AgentTradingNotice } from '@/components/AgentTradingNotice';
import { SaveBasketButton } from '@/components/SaveBasketButton';
import { Button } from '@/components/ui/button';
import { isManualBettingEnabled } from '@/env';
import { ArrowLeft } from 'lucide-react';

export default function BuilderPage() {
  const { items, updateProbabilities } = useBasket();
  const [previousIndex, setPreviousIndex] = useState<number | undefined>();
  const manualBettingEnabled = isManualBettingEnabled();
  
  // Track previous probabilities to avoid infinite update loop
  const lastProbUpdateRef = useRef<string>('');

  // Fetch current market data (refresh every 5 seconds for real-time live prices)
  const { data: marketsData } = useQuery({
    queryKey: ['markets', ''],
    queryFn: () => searchMarkets(''),
    staleTime: 0, // Always fetch fresh data
    refetchInterval: 1000, // Refetch every 5 seconds for live updates
    refetchIntervalInBackground: true, // Continue refetching in background
  });

  // Fetch individual market details for basket items not in search results
  const itemMarketIds = useMemo(() => 
    items.map(item => item.marketId).filter((id, idx, arr) => arr.indexOf(id) === idx),
    [items]
  );

  // Fetch market details for items (live updates every 5 seconds)
  const { data: itemMarketsData } = useQuery({
    queryKey: ['market-details', itemMarketIds],
    queryFn: async () => {
      const markets = new Map<string, PolymarketMarket>();
      await Promise.all(
        itemMarketIds.map(async (id) => {
          const market = await getMarketDetails(id);
          if (market) markets.set(id, market);
        })
      );
      return markets;
    },
    enabled: itemMarketIds.length > 0,
    staleTime: 0, // Always fetch fresh data
    refetchInterval: 1000, // Refetch every 5 seconds for live updates
    refetchIntervalInBackground: true, // Continue refetching in background
  });

  // Build probability and price maps
  const marketProbabilities = useMemo(() => {
    const map = new Map<string, OutcomeProbabilities>();
    const allMarkets = new Map<string, PolymarketMarket>();
    
    // Add markets from search results
    if (marketsData?.markets) {
      marketsData.markets.forEach(market => {
        allMarkets.set(market.id, market);
        map.set(market.id, getOutcomeProbabilities(market));
      });
    }

    // Add markets from individual fetches
    if (itemMarketsData) {
      itemMarketsData.forEach((market, id) => {
        if (!allMarkets.has(id)) {
          allMarkets.set(id, market);
          map.set(id, getOutcomeProbabilities(market));
        }
      });
    }

    // Fallback for items that might not be in results
    items.forEach(item => {
      if (!map.has(item.marketId) && item.currentProb !== undefined) {
        map.set(item.marketId, {
          YES: item.outcome === 'YES' ? item.currentProb : 1 - item.currentProb,
          NO: item.outcome === 'NO' ? item.currentProb : 1 - item.currentProb,
        });
      }
    });

    return map;
  }, [marketsData, itemMarketsData, items]);

  // Build market prices map for display
  const marketPrices = useMemo(() => {
    const map = new Map<string, { YES: number; NO: number }>();
    
    // Add prices from search results
    if (marketsData?.markets) {
      marketsData.markets.forEach(market => {
        const prices = getOutcomePrices(market);
        if (prices) map.set(market.id, prices);
      });
    }

    // Add prices from individual fetches
    if (itemMarketsData) {
      itemMarketsData.forEach((market, id) => {
        const prices = getOutcomePrices(market);
        if (prices) map.set(id, prices);
      });
    }

    return map;
  }, [marketsData, itemMarketsData]);

  // Update item probabilities when market data changes
  // Use ref to avoid infinite loop - only update if probabilities actually changed
  useEffect(() => {
    if (marketProbabilities.size > 0) {
      // Create a stable hash of the current probabilities to compare
      const probHash = Array.from(marketProbabilities.entries())
        .map(([id, p]) => `${id}:${p.YES.toFixed(4)}:${p.NO.toFixed(4)}`)
        .sort()
        .join('|');
      
      // Only update if probabilities actually changed
      if (probHash !== lastProbUpdateRef.current) {
        lastProbUpdateRef.current = probHash;
        updateProbabilities(marketProbabilities);
      }
    }
  }, [marketProbabilities, updateProbabilities]);

  return (
    <div className="content-grid py-8">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <Link to="/explorer">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl md:text-5xl font-display font-bold mb-2 tracking-tight gradient-text reveal">Basket Builder</h1>
          <p className="text-muted-foreground text-base reveal reveal-delay-1">
            {manualBettingEnabled
              ? 'Configure weights and save your basket onchain'
              : 'Configure basket ideas here and execute onchain through your agent'}
          </p>
        </div>
      </div>

      {/* Main Grid */}
      <div className="grid lg:grid-cols-2 gap-4 lg:gap-8">
        {/* Left: Builder */}
        <div className="space-y-6">
          <BasketBuilder 
            marketPrices={marketPrices}
            marketProbabilities={marketProbabilities}
          />
        </div>

        {/* Right: Index & Save */}
        <div className="space-y-6">
          <BasketIndex 
            marketProbabilities={marketProbabilities}
            marketPrices={marketPrices}
            previousIndex={previousIndex}
          />
          
          {items.length > 0 && manualBettingEnabled && (
            <SaveBasketButton 
              marketProbabilities={marketProbabilities}
              marketPrices={marketPrices}
            />
          )}
          {items.length > 0 && !manualBettingEnabled && (
            <AgentTradingNotice description="This builder remains available for planning and reviewing basket composition, but on-chain basket creation and the initial stake must be sent through your agent workflow." />
          )}
        </div>
      </div>
    </div>
  );
}
