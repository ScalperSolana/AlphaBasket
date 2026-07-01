import { useMemo, useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Basket } from '@/types/basket.ts';
import { getFollowerCount } from '@/lib/basket-storage.ts';
import { truncateAddress, calculateBasketIndex, getChangeClass, getCreationSnapshotIndex } from '@/lib/basket-utils.ts';
import { getMarketDetailsBatch, getOutcomeProbabilities, getOutcomePrices } from '@/lib/polymarket.ts';
import { OutcomeProbabilities } from '@/types/polymarket.ts';
import { calculateSuggestedBetAmount, formatUsdc } from '@/lib/betCalculator.ts';
import { NETWORKS } from '@/lib/network.ts';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Users, Layers, Circle, RefreshCw, ChevronDown, ChevronUp, TrendingUp, TrendingDown, ExternalLink, Calculator, Trash2, MoreVertical } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const LOW_BASE_PROBABILITY_THRESHOLD = 0.05;

function getReadyOutcomeProbabilities(market: { outcomePrices?: string[] | null }): OutcomeProbabilities | null {
  const prices = market.outcomePrices;
  if (!prices || prices.length < 2) {
    return null;
  }

  const yesProb = Number.parseFloat(prices[0]);
  const noProb = Number.parseFloat(prices[1]);
  if (!Number.isFinite(yesProb) || !Number.isFinite(noProb) || yesProb < 0 || noProb < 0) {
    return null;
  }

  const sum = yesProb + noProb;
  if (sum <= 0) {
    return null;
  }

  return {
    YES: yesProb / sum,
    NO: noProb / sum,
  };
}

interface BasketCardProps {
  basket: Basket;
  onDelete?: () => void;
  isDeleting?: boolean;
}

export function BasketCard({ basket, onDelete, isDeleting }: BasketCardProps) {
  const followers = getFollowerCount(basket.id);
  const networkConfig = NETWORKS[basket.network];

  // Track last update time for visual feedback
  const [lastUpdateTime, setLastUpdateTime] = useState<Date | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const prevLiveIndexRef = useRef<number | null>(null);

  // Fetch market data for this basket's items
  const basketMarketIds = useMemo(() => {
    return basket.items.map(item => item.marketId).filter((id, idx, arr) => arr.indexOf(id) === idx);
  }, [basket.items]);

  const { 
    data: itemMarketsData, 
    isLoading, 
    isFetching, 
    error,
    refetch,
    dataUpdatedAt 
  } = useQuery({
    queryKey: ['market-details', basketMarketIds.sort().join(',')],
    queryFn: async () => {
      setIsUpdating(true);
      try {
        const markets = await getMarketDetailsBatch(basketMarketIds);
        setLastUpdateTime(new Date());
        return markets;
      } finally {
        setIsUpdating(false);
      }
    },
    enabled: basketMarketIds.length > 0,
    staleTime: 3000, // Consider data fresh for 3 seconds
    refetchInterval: 2000, // Refetch every 2 seconds for live PnL
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    gcTime: 30000,
    retry: 1,
  });

  // Update last update time when data changes
  useEffect(() => {
    if (dataUpdatedAt) {
      setLastUpdateTime(new Date(dataUpdatedAt));
    }
  }, [dataUpdatedAt]);

  // Calculate live index and market prices from REAL Polymarket data
  const { liveIndex, marketPrices, marketStatuses, hasValidData } = useMemo(() => {
    const snapshotIndex = getCreationSnapshotIndex(basket);

    // Only calculate if we have REAL live data for ALL markets
    if (!itemMarketsData || itemMarketsData.size === 0 || basket.items.length === 0) {
      return {
        liveIndex: snapshotIndex ?? 0,
        marketPrices: new Map<string, { YES: number; NO: number }>(),
        marketStatuses: new Map<string, { closed: boolean; active: boolean; resolved?: 'YES' | 'NO' | null }>(),
        hasValidData: false,
      };
    }

    // Check if we have data for all markets
    const missingMarkets = basket.items.filter(item => !itemMarketsData.has(item.marketId));

    const probMap = new Map<string, OutcomeProbabilities>();
    const priceMap = new Map<string, { YES: number; NO: number }>();
    const statusMap = new Map<string, { closed: boolean; active: boolean; resolved?: 'YES' | 'NO' | null }>();

    // Use ONLY live data from Polymarket API
    itemMarketsData.forEach((market, id) => {
      if (!market) {
        console.warn(`[BasketCard] Null market data for ${id}`);
        return;
      }
      
      // Get live probabilities and prices from Polymarket
      const probs = getOutcomeProbabilities(market);
      const prices = getOutcomePrices(market);
      
      // Determine if market is resolved
      let resolved: 'YES' | 'NO' | null = null;
      if (market.closed && prices) {
        const yesPrice = prices.YES;
        const noPrice = prices.NO;
        if (yesPrice >= 0.99 && noPrice <= 0.01) {
          resolved = 'YES';
        } else if (noPrice >= 0.99 && yesPrice <= 0.01) {
          resolved = 'NO';
        }
      }
      
      console.log(`[BasketCard] Market ${id} - YES: ${probs.YES.toFixed(3)}, NO: ${probs.NO.toFixed(3)}, Closed: ${market.closed}, Resolved: ${resolved}`);
      
      probMap.set(id, probs);
      if (prices) {
        priceMap.set(id, prices);
      }
      statusMap.set(id, {
        closed: market.closed,
        active: market.active,
        resolved,
      });
    });

    // Calculate live index from REAL market data ONLY
    const calculatedLiveIndex = calculateBasketIndex(basket.items, probMap);
    
    console.log(`[BasketCard] FINAL Calculated live index for ${basket.id}: ${calculatedLiveIndex.toFixed(3)} (from ${itemMarketsData.size} live markets, snapshot: ${basket.createdSnapshot?.basketIndex ?? 0})`);

    // Track if liveIndex actually changed
    if (prevLiveIndexRef.current !== null && prevLiveIndexRef.current !== calculatedLiveIndex) {
      console.log(`[BasketCard] ${basket.id} - LiveIndex CHANGED: ${prevLiveIndexRef.current.toFixed(3)} → ${calculatedLiveIndex.toFixed(3)}`);
    }
    prevLiveIndexRef.current = calculatedLiveIndex;

    // Only mark as valid if we have data for all or most markets
    return { 
      liveIndex: calculatedLiveIndex, 
      marketPrices: priceMap, 
      marketStatuses: statusMap,
      hasValidData: missingMarkets.length === 0
    };
  }, [itemMarketsData, basket.items, basket.createdSnapshot?.basketIndex, basket.id]);

  // Calculate per-item changes since creation
  const itemChanges = useMemo(() => {
    if (!basket.createdSnapshot?.components || !itemMarketsData) {
      return new Map<number, {
        currentProb: number;
        originalProb: number;
        change: number;
        changePercent: number | null;
        multiple: number | null;
        isLowBase: boolean;
      }>();
    }

    const changes = new Map<number, {
      currentProb: number;
      originalProb: number;
      change: number;
      changePercent: number | null;
      multiple: number | null;
      isLowBase: boolean;
    }>();
    
    basket.items.forEach((item, itemIndex) => {
      const market = itemMarketsData.get(item.marketId);
      if (!market) return;

      const probs = getReadyOutcomeProbabilities(market);
      if (!probs) return;

      const snapshotComponent = basket.createdSnapshot.components.find(c => c.itemIndex === itemIndex);
      if (!snapshotComponent) return;

      const currentProb = item.outcome === 'YES' ? probs.YES : probs.NO;
      const originalProb = snapshotComponent.prob;
      
      const change = currentProb - originalProb;
      const isLowBase = originalProb > 0 && originalProb < LOW_BASE_PROBABILITY_THRESHOLD;
      const changePercent = change * 100;
      const multiple = originalProb > 0 && isLowBase
        ? currentProb / originalProb
        : null;

      changes.set(itemIndex, {
        currentProb,
        originalProb,
        change,
        changePercent,
        multiple,
        isLowBase,
      });
    });

    return changes;
  }, [basket.items, basket.createdSnapshot, itemMarketsData]);

  // Calculate percentage change since creation - EXACT calculation
  // CRITICAL: Only calculate if we have valid live data - never use snapshot as live index
  const indexAtCreation = getCreationSnapshotIndex(basket);
  
  // Only calculate percentage if we have valid live data AND valid snapshot
  // If hasValidData is false, we don't have real market data, so percentage would be wrong
  let indexChange = 0;
  let indexChangePercent = 0;
  
  if (hasValidData && indexAtCreation !== null) {
    indexChange = liveIndex - indexAtCreation;
    indexChangePercent = indexChange * 100;
    
    // Validate calculation is reasonable (sanity check)
    if (isNaN(indexChangePercent) || !isFinite(indexChangePercent)) {
      console.error(`[BasketCard] Invalid percentage calculation for ${basket.id}:`, {
        liveIndex,
        indexAtCreation,
        indexChange,
        indexChangePercent
      });
      indexChangePercent = 0;
    }
  } else {
    // Don't show percentage if we don't have valid data
    if (!hasValidData) {
      console.warn(`[BasketCard] Cannot calculate accurate percentage for ${basket.id} - missing live market data`);
    }
    if (indexAtCreation === null) {
      console.warn(`[BasketCard] Cannot calculate accurate percentage for ${basket.id} - missing basket creation snapshot`);
    }
  }
  
  // Debug logging to track if values are updating
  useEffect(() => {
    console.log(`[BasketCard] ${basket.id} - Live Update:`, {
      basketName: basket.name,
      indexAtCreation: indexAtCreation?.toFixed(3) ?? null,
      liveIndex: liveIndex.toFixed(3),
      absoluteChange: indexChange.toFixed(3),
      percentChange: indexChangePercent.toFixed(2) + '%',
      hasLiveData: !!itemMarketsData && itemMarketsData.size > 0,
      marketsCount: itemMarketsData?.size || 0,
      lastUpdate: lastUpdateTime?.toLocaleTimeString() || 'never',
      isFetching,
      error: error?.message || null,
    });
  }, [liveIndex, indexAtCreation, itemMarketsData, lastUpdateTime, isFetching, error, basket.id, basket.name]);

  // Calculate suggested bet amount
  const suggestedBetAmount = useMemo(() => {
    return calculateSuggestedBetAmount(basket.items);
  }, [basket.items]);
  const suggestedBetDisplay = useMemo(() => {
    return formatUsdc(suggestedBetAmount);
  }, [suggestedBetAmount]);

  // State for expanding item details
  const [showItemDetails, setShowItemDetails] = useState(false);
  const isOnChain = basket.id.startsWith('onchain-');

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onDelete && !isOnChain) {
      onDelete();
    }
  };

  return (
    <div className="relative group">
      <Link to={`/basket/${basket.id}`}>
        <Card className="card-elevated card-hover overflow-hidden h-full">
          <CardContent className="p-5">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-base truncate">{basket.name}</h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  by {truncateAddress(basket.owner)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <Circle className="w-2 h-2 fill-[#14F195] text-[#14F195]" />
                  <span className="text-xs text-muted-foreground">
                    {networkConfig.name}
                  </span>
                </div>
                {onDelete && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-muted rounded"
                        title="Basket options"
                      >
                        <MoreVertical className="w-4 h-4 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem
                        onClick={handleDeleteClick}
                        disabled={isDeleting || isOnChain}
                        className="text-destructive focus:text-destructive focus:bg-destructive/10"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        {isDeleting ? 'Deleting...' : isOnChain ? 'Cannot delete (on-chain)' : 'Delete Basket'}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </div>

          {/* Description */}
          {basket.description && (
            <p className="text-sm text-muted-foreground mb-3 line-clamp-2">
              {basket.description}
            </p>
          )}

          {/* Tags */}
          {basket.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {basket.tags.map(tag => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          )}

          {/* Stats */}
          <div className="space-y-3">
            {/* Live Index */}
            <div className="flex items-baseline gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <span className="text-2xl font-semibold tabular-nums">
                  {liveIndex.toFixed(3)}
                </span>
                {isUpdating || isFetching ? (
                  <RefreshCw className="w-3 h-3 text-muted-foreground animate-spin" />
                ) : lastUpdateTime ? (
                  <span className="text-[10px] text-muted-foreground" title={`Last updated: ${lastUpdateTime.toLocaleTimeString()}`}>
                    Live
                  </span>
                ) : null}
              </div>
              <span className="text-xs text-muted-foreground">Index</span>
            </div>
            
            {/* Error indicator */}
            {error && (
              <div className="text-xs text-destructive">
                Error loading live data. Retrying...
              </div>
            )}
            
            {/* Debug info (only in development) */}
            {import.meta.env.DEV && (
              <details className="text-[10px] text-muted-foreground mt-2">
                <summary className="cursor-pointer">Debug Info</summary>
                <div className="mt-1 space-y-0.5 pl-2 border-l-2 border-muted">
                  <div>Creation Index: {indexAtCreation !== null ? indexAtCreation.toFixed(3) : '—'}</div>
                  <div>Live Index: {liveIndex.toFixed(3)}</div>
                  <div>
                    Change: {indexChange.toFixed(3)} ({indexChangePercent >= 0 ? '+' : ''}{indexChangePercent.toFixed(2)}%)
                  </div>
                  <div>Markets: {itemMarketsData?.size || 0}/{basket.items.length}</div>
                  <div>Last Update: {lastUpdateTime?.toLocaleTimeString() || 'never'}</div>
                  <div>Status: {isFetching ? 'fetching' : error ? 'error' : 'ok'}</div>
                </div>
              </details>
            )}

            {/* Suggested Bet Amount */}
            <div className="text-xs text-muted-foreground">
              Suggested bet: <span className="font-medium">{suggestedBetDisplay}</span>
            </div>

            {/* Items & Followers */}
            <div className="flex items-center justify-between text-muted-foreground text-sm">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <Layers className="w-3.5 h-3.5" />
                  {basket.items.length}
                </span>
                <span className="flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" />
                  {followers}
                </span>
                {marketStatuses.size > 0 && (() => {
                  const closedCount = Array.from(marketStatuses.values()).filter(s => s.closed).length;
                  const resolvedCount = Array.from(marketStatuses.values()).filter(s => s.resolved !== null && s.resolved !== undefined).length;
                  const openCount = basket.items.length - closedCount;
                  return (
                    <span className="flex items-center gap-1 text-xs" title={`${resolvedCount} resolved, ${closedCount - resolvedCount} closed (unresolved), ${openCount} open`}>
                      <Circle className={`w-2.5 h-2.5 ${resolvedCount === basket.items.length ? 'fill-green-500 text-green-500' : closedCount > 0 ? 'fill-yellow-500 text-yellow-500' : 'fill-blue-500 text-blue-500'}`} />
                      {resolvedCount}/{basket.items.length}
                    </span>
                  );
                })()}
              </div>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setShowItemDetails(!showItemDetails);
                }}
                className="flex items-center gap-1 text-xs hover:text-foreground transition-colors"
              >
                {showItemDetails ? (
                  <>
                    <ChevronUp className="w-3 h-3" />
                    Hide items
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-3 h-3" />
                    Show items
                  </>
                )}
              </button>
            </div>

            {/* Item-by-item changes (expandable) */}
            {showItemDetails && itemChanges.size > 0 && (
              <div className="mt-3 pt-3 border-t space-y-2">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-medium text-muted-foreground">Item Changes (Live)</div>
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Calculator className="w-3 h-3" />
                    <span>Hover for math details</span>
                  </div>
                </div>
                {basket.items.map((item, itemIndex) => {
                  const change = itemChanges.get(itemIndex);
                  if (!change) return null;

                  const isPositive = change.change >= 0;
                  const Icon = isPositive ? TrendingUp : TrendingDown;
                  const polymarketUrl = item.slug ? `https://polymarket.com/event/${item.slug}` : null;
                  const marketStatus = marketStatuses.get(item.marketId);
                  const isResolved = marketStatus?.resolved !== null && marketStatus?.resolved !== undefined;
                  const resolvedOutcome = marketStatus?.resolved;
                  const isClosed = marketStatus?.closed ?? false;

                  return (
                    <div 
                      key={`${item.marketId}-${item.outcome}`}
                      className="flex items-center justify-between text-xs p-2 rounded bg-muted/50 group"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <div className="truncate font-medium flex-1">{item.question}</div>
                          {polymarketUrl && (
                            <a
                              href={polymarketUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="Verify on Polymarket"
                            >
                              <ExternalLink className="w-3 h-3 text-muted-foreground hover:text-foreground" />
                            </a>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground mt-0.5">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${
                            item.outcome === 'YES' ? 'bg-accent' : 'bg-muted-foreground'
                          }`} />
                          <span>{item.outcome} • {(item.weightBps / 100).toFixed(1)}%</span>
                          {marketStatus && (
                            <span className={`text-[10px] px-1 py-0.5 rounded ${
                              isResolved 
                                ? resolvedOutcome === item.outcome 
                                  ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
                                  : 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300'
                                : isClosed
                                  ? 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300'
                                  : 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                            }`}>
                              {isResolved ? `Resolved ${resolvedOutcome}` : isClosed ? 'Closed' : 'Open'}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          Original: {(change.originalProb * 100).toFixed(1)}%
                        </div>
                      </div>
                      <div className="flex items-center gap-2 ml-2">
                        <div 
                          className="text-right cursor-help"
                        >
                          <div className="font-medium tabular-nums">
                            {(change.currentProb * 100).toFixed(1)}%
                          </div>
                          <div className={`text-[10px] flex items-center gap-0.5 ${
                            isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                          }`}>
                            <Icon className="w-2.5 h-2.5" />
                            {isPositive ? '+' : ''}{(change.change * 100).toFixed(1)}%
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          </CardContent>
        </Card>
      </Link>
    </div>
  );
}
