import { useState, useEffect, useCallback, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Search, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { searchMarkets, fetchCuratedLatest, fetchMarkets, fetchMarketsByCategory, fetchEndingSoonMarkets, rankMarketsForSearch, isTradeableMarket, POLYMARKET_CATEGORIES, type MarketCategory } from '@/lib/polymarket.ts';
import { MarketCard } from './MarketCard';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import type { PolymarketMarket } from '@/types/polymarket.ts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils.ts';
import { filterBettableMarkets } from '@/lib/betCutoff';

export function MarketSearch() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<MarketCategory>('all');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const queryFn = useCallback(async () => {
    const trimmedQuery = debouncedQuery.trim();
    const categoryConfig = POLYMARKET_CATEGORIES.find((category) => category.id === selectedCategory);

    // If there's a search query, search within the selected category scope
    if (debouncedQuery && debouncedQuery.trim().length > 0) {
      console.log('[MarketSearch] Searching for:', trimmedQuery, 'within category:', selectedCategory);
      try {
        let scopedMarkets: PolymarketMarket[] = [];

        if (selectedCategory === 'ending-soon') {
          scopedMarkets = await fetchEndingSoonMarkets(180);
        } else if (selectedCategory === 'all') {
          scopedMarkets = await fetchMarkets({
            active: true,
            closed: false,
            limit: 250,
            orderBy: 'volume',
            ascending: false,
          });
        } else {
          scopedMarkets = await fetchMarketsByCategory(selectedCategory, 180);
        }

        let rankedScoped = rankMarketsForSearch(scopedMarkets, trimmedQuery, 50);
        console.log('[MarketSearch] Scoped search results:', rankedScoped.length, 'markets found');

        if (selectedCategory === 'ending-soon') {
          return rankedScoped;
        }

        // Always hit the live API for the query too, then merge + re-rank, so
        // results are comprehensive and precise (never just stale local hits).
        const additionalFilters = categoryConfig?.tagId != null
          ? { tagId: categoryConfig.tagId }
          : undefined;

        const result = await searchMarkets(trimmedQuery, additionalFilters, selectedCategory);
        const merged = [...rankedScoped, ...result.markets].filter((market, index, array) =>
          array.findIndex((candidate) => candidate.id === market.id) === index
        );
        rankedScoped = rankMarketsForSearch(merged, trimmedQuery, 50);
        console.log('[MarketSearch] Final merged search results:', rankedScoped.length, 'markets found');
        return rankedScoped;
      } catch (error) {
        console.error('[MarketSearch] Search error:', error);
        return [];
      }
    }
    
    // No search query - fetch by category or curated latest
    if (selectedCategory === 'all') {
      console.log('[MarketSearch] Fetching all markets (curated latest)');
      try {
        const markets = await fetchCuratedLatest();
        console.log('[MarketSearch] All markets results:', markets.length, 'markets found');
        return markets;
      } catch (error) {
        console.error('[MarketSearch] Error fetching all markets:', error);
        return [];
      }
    }
    
    // Fetch by category
    console.log('[MarketSearch] Fetching category:', selectedCategory);
    try {
      const markets = await fetchMarketsByCategory(selectedCategory, 50);
      console.log('[MarketSearch] Category results:', markets.length, 'markets found for', selectedCategory);
      
      // If no results, log warning
      if (markets.length === 0) {
        console.warn(`[MarketSearch] No markets found for category: ${selectedCategory}. Check browser console for API details.`);
      }
      
      return markets;
    } catch (error) {
      console.error('[MarketSearch] Category fetch error:', error);
      return [];
    }
  }, [debouncedQuery, selectedCategory]);

  // Check if search is active (must be defined before useQuery)
  const isSearchActive = debouncedQuery && debouncedQuery.trim().length > 0;

  const { data, isLoading, isFetching, isError, error } = useQuery({
    queryKey: ['markets', debouncedQuery, selectedCategory],
    queryFn,
    staleTime: 0, // Always fetch fresh data for live updates - never use stale data
    // Continuously refetch to catch new markets
    // When searching, only refetch on manual refresh or window focus
    // When browsing categories, refetch every 2 seconds to catch new markets
    refetchInterval: isSearchActive ? false : 2000, // Refetch every 2 seconds to catch new markets
    refetchIntervalInBackground: !isSearchActive, // Continue refetching in background to catch new markets
    refetchOnWindowFocus: true, // Refetch when user returns to tab
    refetchOnMount: true, // Always refetch on mount to get latest markets
    retry: 3, // Retry failed requests
    retryDelay: (attemptIndex) => Math.min(500 * 2 ** attemptIndex, 3000), // Faster exponential backoff
  }) as { data?: PolymarketMarket[]; isLoading: boolean; isFetching: boolean; isError: boolean; error: unknown };

  // Compose the bet-cutoff filter with the display filter that hides already-decided
  // / lopsided markets (one side ≥ 95%) — they're real Polymarket markets but carry
  // no prediction value. Display-only; never gates settlement.
  const bettableMarkets = useMemo(
    () => (data ? filterBettableMarkets(data).filter(isTradeableMarket) : undefined),
    [data],
  );

  return (
    <div className="space-y-6">
      {/* Category Filter Tabs */}
      <div className="flex flex-wrap gap-2">
        {POLYMARKET_CATEGORIES.map((category) => {
          const isEndingSoon = category.id === 'ending-soon';
          const isSelected = selectedCategory === category.id;
          return (
            <Button
              key={category.id}
              variant={isSelected ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSelectedCategory(category.id)}
              className={cn(
                'transition-all duration-200',
                isSelected ? 'bg-primary text-primary-foreground shadow-md' : 'hover:bg-secondary',
                isEndingSoon && isSelected && 'ring-2 ring-orange-500 ring-offset-2',
                isEndingSoon && !isSelected && 'border-orange-500/50'
              )}
            >
              {category.label}
              {isEndingSoon && <span className="ml-1.5 text-xs opacity-75">⚡</span>}
            </Button>
          );
        })}
      </div>

      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder={selectedCategory === 'all'
            ? 'Search any Polymarket... (e.g., Trump, Bitcoin, Super Bowl, Elections)'
            : `Search within ${POLYMARKET_CATEGORIES.find((category) => category.id === selectedCategory)?.label || selectedCategory}...`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-10 h-12 text-base"
        />
        {isFetching && (
          <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
        )}
      </div>

      {/* Auto-refresh indicator - hidden for cleaner UX, data still refreshes in background */}

      {/* Results */}
      {isError ? (
        <div className="text-center py-12">
          <div className="text-destructive mb-2">
            Failed to load markets{error instanceof Error ? `: ${error.message}` : ''}
          </div>
          <div className="text-sm text-muted-foreground">
            Please check your browser console for more details. The Polymarket API might be temporarily unavailable.
          </div>
        </div>
      ) : isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <Card key={i} className="overflow-hidden border-border/50">
              <CardContent className="p-6 space-y-4">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-5 w-16 rounded-full" />
                  <Skeleton className="h-2 w-2 rounded-full" />
                </div>
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <div className="grid grid-cols-2 gap-3">
                  <Skeleton className="h-16 rounded-md" />
                  <Skeleton className="h-16 rounded-md" />
                </div>
                <Skeleton className="h-1.5 w-full rounded-full" />
                <div className="flex gap-4">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-5 w-20 ml-auto rounded-full" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Skeleton className="h-8 rounded-md" />
                  <Skeleton className="h-8 rounded-md" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : bettableMarkets && bettableMarkets.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {bettableMarkets.map((market, index) => (
            <MarketCard key={`${market.id}-${index}`} market={market} index={index} />
          ))}
        </div>
      ) : (
        <div className="text-center py-12 text-muted-foreground">
          {debouncedQuery
            ? selectedCategory === 'all'
              ? `No markets found for "${debouncedQuery}"`
              : `No markets found for "${debouncedQuery}" in ${POLYMARKET_CATEGORIES.find(c => c.id === selectedCategory)?.label || selectedCategory}`
            : selectedCategory === 'ending-soon'
            ? 'No markets ending within the next hour. Check back soon!'
            : selectedCategory !== 'all'
            ? `No markets found in ${POLYMARKET_CATEGORIES.find(c => c.id === selectedCategory)?.label || selectedCategory}`
            : 'Search for prediction markets to add to your basket'}
        </div>
      )}
    </div>
  );
}
