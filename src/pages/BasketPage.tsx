import { useParams, Link, useNavigate } from 'react-router-dom';
import { useMemo, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getBasketById,
  isFollowing,
  followBasket,
  unfollowBasket,
  getFollowerCount,
  deleteBasket,
  getOwnerPositionForBasket,
} from '@/lib/basket-storage.ts';
import {
  getOutcomeProbabilities,
  getOutcomePrices,
  getMarketDetailsBatch,
  formatProbability,
  formatPrice,
} from '@/lib/polymarket.ts';
import { OutcomeProbabilities } from '@/types/polymarket.ts';
import {
  calculateBasketIndex,
  truncateAddress,
  formatWeight,
  getChangeClass,
  getCreationSnapshotIndex,
} from '@/lib/basket-utils.ts';
import { useWallet } from '@/contexts/WalletContext';
import { useNetwork } from '@/contexts/NetworkContext';
import { NETWORKS } from '@/lib/network.ts';
import { fromUsdcUnits, usdcUnitsToNumber } from '@/lib/solana/usdc.ts';
import { basketIdBytes, fetchBasket } from '@/lib/solana/escrowProgram.ts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import {
  ArrowLeft, Heart, Copy, Circle, ExternalLink, Layers, Clock, Users, Loader2,
  Coins, CheckCircle, Calculator, Trash2,
} from 'lucide-react';
import { BetLanePanel } from '@/components/BetLanePanel';

const LOW_BASE_PROBABILITY_THRESHOLD = 0.05;

type MarketStatus = { closed: boolean; active: boolean; resolved: 'YES' | 'NO' | null };

export default function BasketPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { address } = useWallet();
  const { network } = useNetwork();
  const { toast } = useToast();
  const networkConfig = NETWORKS[network];

  const [basket, setBasket] = useState(() => (id ? getBasketById(id) : null));
  const [following, setFollowing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (id) {
      setBasket(getBasketById(id));
    }
  }, [id]);

  useEffect(() => {
    if (id && address) {
      setFollowing(isFollowing(address, id));
    }
  }, [id, address]);

  const followers = id ? getFollowerCount(id) : 0;

  const basketMarketIds = useMemo(
    () => (basket ? basket.items.map((item) => item.marketId).filter((v, i, a) => a.indexOf(v) === i) : []),
    [basket],
  );

  const { data: itemMarketsData, isFetching } = useQuery({
    queryKey: ['market-details', basketMarketIds.sort().join(',')],
    queryFn: () => getMarketDetailsBatch(basketMarketIds),
    enabled: basketMarketIds.length > 0,
    staleTime: 3000,
    refetchInterval: 5000,
  });

  // Per-item live data, statuses, and changes vs the creation snapshot.
  const { liveIndex, rows, statuses, hasValidData } = useMemo(() => {
    const probMap = new Map<string, OutcomeProbabilities>();
    const statusMap = new Map<string, MarketStatus>();
    const itemRows: Array<{
      key: string;
      item: (typeof basket.items)[number];
      price: number | null;
      currentProb: number | null;
      marketStatus: MarketStatus | null;
      isResolved: boolean;
      isClosed: boolean;
      resolvedOutcome: 'YES' | 'NO' | null;
      change: { change: number; originalProb: number; isLowBase: boolean } | null;
      isPositive: boolean;
      polymarketUrl: string | null;
    }> = [];

    if (!basket) {
      return { liveIndex: 0, rows: itemRows, statuses: statusMap, hasValidData: false };
    }

    basket.items.forEach((item, itemIndex) => {
      const market = itemMarketsData?.get(item.marketId);
      let price: number | null = null;
      let currentProb: number | null = null;
      let marketStatus: MarketStatus | null = null;

      if (market) {
        const probs = getOutcomeProbabilities(market);
        const prices = getOutcomePrices(market);
        probMap.set(item.marketId, probs);
        currentProb = item.outcome === 'YES' ? probs.YES : probs.NO;
        if (prices) {
          price = item.outcome === 'YES' ? prices.YES : prices.NO;
        }
        let resolved: 'YES' | 'NO' | null = null;
        if (market.closed && prices) {
          if (prices.YES >= 0.99 && prices.NO <= 0.01) resolved = 'YES';
          else if (prices.NO >= 0.99 && prices.YES <= 0.01) resolved = 'NO';
        }
        marketStatus = { closed: market.closed, active: market.active, resolved };
        statusMap.set(item.marketId, marketStatus);
      }

      const snapshotComponent = basket.createdSnapshot?.components?.find((c) => c.itemIndex === itemIndex);
      let change: { change: number; originalProb: number; isLowBase: boolean } | null = null;
      if (snapshotComponent && currentProb !== null) {
        const originalProb = snapshotComponent.prob;
        change = {
          change: currentProb - originalProb,
          originalProb,
          isLowBase: originalProb > 0 && originalProb < LOW_BASE_PROBABILITY_THRESHOLD,
        };
      }

      itemRows.push({
        key: `${item.marketId}-${item.outcome}`,
        item,
        price,
        currentProb,
        marketStatus,
        isResolved: marketStatus?.resolved != null,
        isClosed: marketStatus?.closed ?? false,
        resolvedOutcome: marketStatus?.resolved ?? null,
        change,
        isPositive: (change?.change ?? 0) >= 0,
        polymarketUrl: item.slug ? `https://polymarket.com/event/${item.slug}` : null,
      });
    });

    const missing = basket.items.filter((item) => !itemMarketsData?.has(item.marketId));
    return {
      liveIndex: calculateBasketIndex(basket.items, probMap),
      rows: itemRows,
      statuses: statusMap,
      hasValidData: !!itemMarketsData && missing.length === 0,
    };
  }, [basket, itemMarketsData]);

  // Off-chain settlement: when every item is resolved, the basket is settled.
  const settlement = useMemo(() => {
    if (!basket || basket.items.length === 0 || statuses.size < basket.items.length) {
      return null;
    }
    let allResolved = true;
    let indexFraction = 0;
    basket.items.forEach((item) => {
      const status = statuses.get(item.marketId);
      if (!status || status.resolved == null) {
        allResolved = false;
        return;
      }
      if (status.resolved === item.outcome) {
        indexFraction += item.weightBps / 10000;
      }
    });
    if (!allResolved) return null;
    return { indexBps: Math.round(indexFraction * 10000), finalized: true };
  }, [basket, statuses]);

  // On-chain settlement (authoritative for claims). The browser-derived
  // settlement above drives display; the program decides actual payouts.
  const { data: onChainBasket } = useQuery({
    queryKey: ['onchain-basket', id],
    enabled: !!id,
    queryFn: async () => {
      const idBytes = await basketIdBytes(id!);
      return fetchBasket(idBytes);
    },
    refetchInterval: 15_000,
  });

  const settlementIndexBps = settlement?.indexBps ?? null;
  const settlementFinalized = settlement?.finalized ?? false;
  const usesSettlementIndex = settlementIndexBps !== null;

  const chainSettled = onChainBasket?.settled ?? false;
  const chainSettlementIndexBps = onChainBasket?.settlementIndexBps ?? null;
  const liveIndexBps = Math.max(1, Math.min(10000, Math.round(liveIndex * 10000)));

  const creationSnapshotIndex = basket ? getCreationSnapshotIndex(basket) : null;
  const displayedIndex = usesSettlementIndex ? settlementIndexBps / 10000 : liveIndex;

  const headlineChange = useMemo(() => {
    if (creationSnapshotIndex === null || creationSnapshotIndex === 0) return 0;
    return ((displayedIndex - creationSnapshotIndex) / creationSnapshotIndex) * 100;
  }, [displayedIndex, creationSnapshotIndex]);

  const position = useMemo(
    () => (address && id ? getOwnerPositionForBasket(address, id) : null),
    [address, id],
  );

  const pnl = useMemo(() => {
    if (!position || settlementIndexBps === null) return null;
    const stakeUnits = BigInt(position.stakeUsdcUnits);
    const entry = position.indexAtCreationBps > 0 ? position.indexAtCreationBps : 1;
    const payoutUnits = (stakeUnits * BigInt(settlementIndexBps)) / BigInt(entry);
    return {
      stake: usdcUnitsToNumber(stakeUnits),
      payout: usdcUnitsToNumber(payoutUnits),
      profit: usdcUnitsToNumber(payoutUnits - stakeUnits),
    };
  }, [position, settlementIndexBps]);

  const handleFollow = () => {
    if (!address || !id) return;
    if (following) {
      unfollowBasket(address, id);
      setFollowing(false);
    } else {
      followBasket(address, id);
      setFollowing(true);
    }
  };

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast({ title: 'Link copied', description: 'Basket link copied to clipboard.' });
    } catch {
      // ignore
    }
  };

  const handleDelete = () => {
    if (!id) return;
    setIsDeleting(true);
    if (deleteBasket(id)) {
      toast({ title: 'Basket deleted' });
      navigate('/me');
    } else {
      setIsDeleting(false);
      toast({ title: 'Could not delete basket', variant: 'destructive' });
    }
  };

  if (!basket) {
    return (
      <div className="content-grid py-16 text-center">
        <p className="text-muted-foreground mb-4">Basket not found.</p>
        <Link to="/explorer">
          <Button variant="outline">Back to Explorer</Button>
        </Link>
      </div>
    );
  }

  const isOwner = !!address && address === basket.owner;
  const basketStatus = settlementFinalized ? 'Settled' : basket.status ?? 'Active';

  return (
    <div className="content-grid py-8">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <Link to="/explorer">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-semibold">{basket.name}</h1>
            <div className="flex items-center gap-1.5">
              <Circle className="w-2 h-2 fill-[#14F195] text-[#14F195]" />
              <span className="text-sm text-muted-foreground">{networkConfig.name}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>by {truncateAddress(basket.owner)}</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleShare}>
              <Copy className="w-3 h-3" />
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleFollow} disabled={!address} className="gap-2">
            <Heart className={`w-4 h-4 ${following ? 'fill-current text-red-500' : ''}`} />
            {following ? 'Following' : 'Follow'}
          </Button>
          {isOwner && (
            <Button variant="ghost" size="icon" onClick={handleDelete} disabled={isDeleting} title="Delete basket">
              <Trash2 className="w-4 h-4 text-destructive" />
            </Button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="grid lg:grid-cols-3 gap-4 lg:gap-8">
        {/* Left: Main Info */}
        <div className="lg:col-span-2 space-y-6">
          {/* Index Card */}
          <Card className="card-elevated">
            <CardContent className="py-6">
              <div className="flex items-baseline gap-4 mb-4">
                <span className="index-display">{displayedIndex.toFixed(3)}</span>
                {(usesSettlementIndex || hasValidData) && creationSnapshotIndex !== null ? (
                  <span className={`stat-chip ${getChangeClass(headlineChange)}`}>
                    {headlineChange >= 0 ? '+' : ''}
                    {headlineChange.toFixed(2)}% {usesSettlementIndex ? 'settled' : 'since creation'}
                  </span>
                ) : (
                  <span className="stat-chip stat-chip-neutral">
                    {creationSnapshotIndex === null ? 'Creation reference unavailable' : 'Loading...'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Layers className="w-4 h-4" />
                  {basket.items.length} items
                </span>
                <span className="flex items-center gap-1.5">
                  <Users className="w-4 h-4" />
                  {followers} followers
                </span>
                <span className="flex items-center gap-1.5">
                  <Clock className="w-4 h-4" />
                  Created {new Date(basket.createdAt).toLocaleDateString()}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Settlement Status */}
          {usesSettlementIndex && (
            <Card className="card-elevated">
              <CardHeader>
                <CardTitle className="text-base">Settlement Status</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Status</span>
                    <Badge variant="default">Finalized</Badge>
                  </div>
                  <div className="text-sm">
                    <span className="text-muted-foreground">Settlement index: </span>
                    <span className="font-medium">{((settlementIndexBps ?? 0) / 100).toFixed(2)}%</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Description & Tags */}
          {(basket.description || basket.tags.length > 0) && (
            <Card className="card-elevated">
              <CardContent className="py-5">
                {basket.description && <p className="text-muted-foreground mb-3">{basket.description}</p>}
                {basket.tags.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {basket.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">{tag}</Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Items Table */}
          <Card className="card-elevated">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Basket Items</CardTitle>
                {isFetching && !usesSettlementIndex && (
                  <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Updating</span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="border rounded-lg divide-y">
                <div className="hidden md:grid grid-cols-9 gap-2 px-4 py-2.5 text-xs font-medium text-muted-foreground bg-muted/50">
                  <span className="col-span-2">Market</span>
                  <span className="text-center">Position</span>
                  <span className="text-right">Status</span>
                  <span className="text-right">Weight</span>
                  <span className="text-right">{usesSettlementIndex ? 'Price (Final)' : 'Price (Live)'}</span>
                  <span className="text-right">{usesSettlementIndex ? 'Prob (Final)' : 'Prob (Live)'}</span>
                  <span className="text-right">Original</span>
                  <span className="text-right">Change</span>
                </div>
                {rows.map((row) => (
                  <div
                    key={row.key}
                    className="flex flex-col gap-1 px-4 py-3 md:grid md:grid-cols-9 md:gap-2 md:items-center hover:bg-muted/30 transition-colors group"
                  >
                    <div className="flex items-center justify-between gap-2 md:col-span-2 md:justify-start min-w-0">
                      <span className="text-sm break-words flex-1" title={row.item.question}>
                        {row.item.question}
                      </span>
                      {row.polymarketUrl && (
                        <a
                          href={row.polymarketUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                          title="Verify on Polymarket"
                        >
                          <ExternalLink className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                        </a>
                      )}
                      <span
                        className={`md:hidden text-xs font-medium px-2 py-0.5 rounded shrink-0 ${
                          row.item.outcome === 'YES' ? 'bg-accent/10 text-accent' : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {row.item.outcome}
                      </span>
                    </div>

                    <span className="hidden md:block text-center">
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded ${
                          row.item.outcome === 'YES' ? 'bg-accent/10 text-accent' : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {row.item.outcome}
                      </span>
                    </span>

                    <span className="hidden md:block text-right">
                      {row.marketStatus ? (
                        row.isResolved ? (
                          <Badge
                            variant={row.resolvedOutcome === row.item.outcome ? 'default' : 'secondary'}
                            className="text-[10px] px-1.5 py-0"
                          >
                            <CheckCircle className="w-2.5 h-2.5 mr-0.5" />
                            {row.resolvedOutcome}
                          </Badge>
                        ) : row.isClosed ? (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            <Clock className="w-2.5 h-2.5 mr-0.5" />
                            Closed
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300">
                            <Circle className="w-2 h-2 mr-0.5 fill-current" />
                            Open
                          </Badge>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </span>

                    <span className="hidden md:block text-right text-sm tabular-nums">{formatWeight(row.item.weightBps)}</span>
                    <span className="hidden md:block text-right text-sm tabular-nums font-medium">
                      {row.price !== null ? formatPrice(row.price) : '-'}
                    </span>
                    <span className="hidden md:block text-right text-sm tabular-nums font-medium">
                      {row.currentProb !== null ? formatProbability(row.currentProb) : '-'}
                    </span>
                    <span className="hidden md:block text-right text-sm tabular-nums text-muted-foreground">
                      {row.change ? formatProbability(row.change.originalProb) : '-'}
                    </span>
                    <span className="hidden md:block text-right text-sm tabular-nums">
                      {row.change ? (
                        <span
                          className={`font-medium ${
                            row.isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                          }`}
                        >
                          {row.isPositive ? '+' : ''}
                          {(row.change.change * 100).toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Index Calculation Breakdown */}
          <Card className="card-elevated">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Calculator className="w-4 h-4" />
                Index Calculation
              </CardTitle>
              <CardDescription>
                The basket index is the weighted average of each market's selected-outcome probability.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-1.5 text-sm">
                {rows.map((row) => (
                  <div key={`calc-${row.key}`} className="flex items-center justify-between">
                    <span className="truncate flex-1 text-muted-foreground" title={row.item.question}>
                      {row.item.question}
                    </span>
                    <span className="ml-2 tabular-nums">
                      {formatWeight(row.item.weightBps)} ×{' '}
                      {row.currentProb !== null ? formatProbability(row.currentProb) : '—'}
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between border-t pt-2 mt-2 font-medium">
                  <span>Index</span>
                  <span className="tabular-nums">{displayedIndex.toFixed(3)}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: Actions */}
        <div className="space-y-6">
          <BetLanePanel
            basketId={id ?? null}
            basketStatus={basketStatus}
            entryIndexBps={liveIndexBps}
            settlementIndexBps={chainSettled ? chainSettlementIndexBps : null}
            settlementFinalized={chainSettled}
          />

          {/* User Position / PnL */}
          {position && (
            <Card className="card-elevated">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Coins className="w-4 h-4 text-[#14F195]" />
                  Your Position
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Stake</span>
                  <span className="font-medium">{fromUsdcUnits(BigInt(position.stakeUsdcUnits))} USDC</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Entry index</span>
                  <span className="font-medium">{(position.indexAtCreationBps / 100).toFixed(2)}%</span>
                </div>
                {pnl && (
                  <>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Payout</span>
                      <span className="font-medium">{pnl.payout.toFixed(2)} USDC</span>
                    </div>
                    <div className="flex justify-between gap-4 border-t pt-2">
                      <span className="text-muted-foreground">Profit / Loss</span>
                      <span className={`font-semibold ${pnl.profit >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {pnl.profit >= 0 ? '+' : ''}
                        {pnl.profit.toFixed(2)} USDC
                      </span>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
