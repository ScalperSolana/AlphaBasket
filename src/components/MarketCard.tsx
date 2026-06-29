import { useState, useEffect, useMemo, useRef } from 'react';
import { PolymarketMarket } from '@/types/polymarket.ts';
import { Outcome } from '@/types/basket.ts';
import { getOutcomeProbabilities, getOutcomePrices, formatVolume, formatProbability, formatPrice, formatCategoryName } from '@/lib/polymarket.ts';
import { useBasket } from '@/contexts/BasketContext';
import { useCountdown } from '@/hooks/useCountdown';
import { useCryptoPrice, fmtCryptoPrice, formatPriceTimestamp } from '@/hooks/useCryptoPrice';
import { useMarketLivePrices } from '@/hooks/useMarketLivePrices';
import { usePriceToBeat } from '@/hooks/usePriceToBeat';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Plus, Check, ExternalLink, Info, Clock } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils.ts';

interface MarketCardProps {
  market: PolymarketMarket;
  index?: number;
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

function extractQuestionWindow(question: string): { title: string; durationMinutes: number } | null {
  const match = question.match(/^(.*?)\s*-\s*[A-Za-z]+\s+\d{1,2},\s*(\d{1,2}:\d{2}(?:AM|PM))\s*-\s*(\d{1,2}:\d{2}(?:AM|PM))\s*ET$/i);
  if (!match) return null;
  const start = parseClockToMinutes(match[2]);
  const end = parseClockToMinutes(match[3]);
  if (start == null || end == null) return null;
  const delta = end > start ? end - start : end - start + 24 * 60;
  if (delta <= 0) return null;
  return { title: match[1].trim(), durationMinutes: delta };
}

function formatQuestionInUserTimezone(market: PolymarketMarket): string {
  const question = market.question || '';
  const parsed = extractQuestionWindow(question);
  if (!parsed) return question;

  const endTs = market.endDate ? new Date(market.endDate).getTime() : Number.NaN;
  const startTs = Number.isFinite(endTs)
    ? endTs - parsed.durationMinutes * 60_000
    : Number.NaN;
  const effectiveEndTs = endTs;

  if (!Number.isFinite(startTs) || !Number.isFinite(effectiveEndTs)) return question;

  const startDate = new Date(startTs);
  const endDate = new Date(effectiveEndTs);
  const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const startDateLabel = dateFormatter.format(startDate);
  const endDateLabel = dateFormatter.format(endDate);
  const startTimeLabel = timeFormatter.format(startDate).replace(/\s/g, '');
  const endTimeLabel = timeFormatter.format(endDate).replace(/\s/g, '');

  if (startDateLabel === endDateLabel) {
    return `${parsed.title} - ${startDateLabel}, ${startTimeLabel}-${endTimeLabel}`;
  }

  return `${parsed.title} - ${startDateLabel} ${startTimeLabel} to ${endDateLabel} ${endTimeLabel}`;
}

export function MarketCard({ market, index = 0 }: MarketCardProps) {
  const { addItem, hasItem } = useBasket();
  const probs = getOutcomeProbabilities(market);
  const prices = getOutcomePrices(market);
  const countdown = useCountdown(market.endDate);

  const isUpDownMarket = market.question?.toLowerCase().includes('up or down')
    || market.outcomes?.some(o => /^(up|down)$/i.test(o));

  const {
    price: livePrice,
    direction,
    updatedAt: livePriceUpdatedAt,
  } = useCryptoPrice(isUpDownMarket ? market : undefined);
  const liveMarketPrices = useMarketLivePrices(isUpDownMarket ? market : undefined);

  const priceToBeat = usePriceToBeat(isUpDownMarket ? market : undefined);
  const effectivePrices = liveMarketPrices ?? prices;
  const effectiveProbs = effectivePrices
    ? (() => {
        const sum = effectivePrices.YES + effectivePrices.NO;
        if (sum > 0) {
          return { YES: effectivePrices.YES / sum, NO: effectivePrices.NO / sum };
        }
        return probs;
      })()
    : probs;

  const prevYesRef = useRef(effectiveProbs.YES);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    if (effectiveProbs.YES !== prevYesRef.current) {
      setFlash(effectiveProbs.YES > prevYesRef.current ? 'up' : 'down');
      prevYesRef.current = effectiveProbs.YES;
      const timer = setTimeout(() => setFlash(null), 600);
      return () => clearTimeout(timer);
    }
  }, [effectiveProbs.YES]);
  
  const outcomeLabels = {
    YES: market.outcomes?.[0] || 'YES',
    NO: market.outcomes?.[1] || 'NO',
  };
  
  const truncateLabel = (label: string, max = 6) => 
    label.length > max ? label.slice(0, max).trim() + '…' : label;
  
  const shortLabels = {
    YES: truncateLabel(outcomeLabels.YES),
    NO: truncateLabel(outcomeLabels.NO),
  };

  const handleAdd = (outcome: Outcome) => {
    addItem(market, outcome);
  };

  const yesSelected = hasItem(market.id, 'YES');
  const noSelected = hasItem(market.id, 'NO');
  const displayQuestion = useMemo(() => formatQuestionInUserTimezone(market), [market]);

  const polymarketUrl = market.slug 
    ? `https://polymarket.com/event/${market.slug}`
    : `https://polymarket.com/event/${market.id}`;

  // Compute price-to-beat comparison
  const ptbNum = priceToBeat ? parseFloat(priceToBeat.replace(/[$,]/g, '')) : null;
  const priceVsBeat = livePrice && ptbNum
    ? livePrice > ptbNum ? 'above' : livePrice < ptbNum ? 'below' : 'equal'
    : null;
  const livePriceLabel = livePrice != null ? fmtCryptoPrice(livePrice) : null;
  const beatLength = priceToBeat?.length ?? 0;
  const liveLength = livePriceLabel?.length ?? 0;
  const beatPriceClass = beatLength >= 11
    ? 'text-[0.98rem]'
    : beatLength >= 9
      ? 'text-[1.1rem]'
      : 'text-[1.38rem]';
  const livePriceClass = liveLength >= 11
    ? 'text-[0.98rem]'
    : liveLength >= 9
      ? 'text-[1.1rem]'
      : 'text-[1.38rem]';

  return (
    <Card
      className="market-card-neutral card-elevated card-hover overflow-hidden border-border/50 relative group animate-in fade-in slide-in-from-bottom-2 duration-300"
      style={{ animationDelay: `${Math.min(index * 50, 300)}ms`, animationFillMode: 'backwards' }}
    >
      <a
        href={polymarketUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute top-3 right-3 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-200 p-1.5 rounded-md bg-background/80 hover:bg-background border border-border/50 hover:border-primary/50 backdrop-blur-sm"
        title="View on Polymarket"
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink className="w-3.5 h-3.5 text-muted-foreground hover:text-primary transition-colors" />
      </a>
      
      <CardContent className="p-6">
        {/* Header */}
        <div className="relative mb-4">
          {market.image && (
            <img
              src={market.image}
              alt=""
              className="absolute left-0 top-0 h-8 w-8 rounded-full border border-border/50 object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          )}
          <div className="min-w-0">
            <div className={cn("mb-2 flex items-center gap-2 flex-wrap", market.image && "pl-11")}>
              {market.category && (
                <Badge variant="secondary" className="text-xs font-medium bg-primary/10 text-primary border-primary/20">
                  {formatCategoryName(market.category)}
                </Badge>
              )}
              {market.active && !market.closed && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
              )}
              {liveMarketPrices && (
                <Badge className="bg-cyan-500/15 text-cyan-300 border-cyan-500/30 text-[10px] px-1.5 py-0">
                  Live Odds
                </Badge>
              )}
              {market.volume24hr && market.volume24hr > 10000 && (
                <Badge className="bg-orange-500/15 text-orange-400 border-orange-500/30 text-[10px] px-1.5 py-0">
                  Trending
                </Badge>
              )}
              {market.description && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-xs">
                      {market.description.slice(0, 200)}{market.description.length > 200 ? '...' : ''}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            <h3 className={cn("font-display text-base font-semibold leading-snug break-words", market.image && "pl-11")} title={market.question}>
              {displayQuestion}
            </h3>

            {/* ── Live Price Panel for Up/Down Markets ── */}
            {isUpDownMarket && livePrice != null && (
              <div className="market-live-panel mt-3 overflow-hidden rounded-2xl border">
                <div className="flex items-center justify-between gap-3 border-b border-border/30 px-4 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="text-[10px] font-medium tracking-[0.18em] text-muted-foreground/70 uppercase whitespace-nowrap">
                      Live Feed
                    </div>
                    <span className="relative flex h-2.5 w-2.5 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
                    </span>
                  </div>
                </div>

                <div className={cn(
                  "grid gap-0",
                  priceToBeat
                    ? "grid-cols-[minmax(0,0.94fr)_minmax(0,1.06fr)]"
                    : "grid-cols-1"
                )}>
                  {priceToBeat && (
                    <div className="flex min-h-[98px] min-w-0 flex-col justify-between border-b border-border/30 px-4 py-3 md:border-b-0 md:border-r">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/65 whitespace-nowrap">
                        Price To Beat
                      </div>
                      <div className="min-h-[38px] pt-1">
                        <div className={cn(
                          "w-full whitespace-nowrap font-mono font-semibold leading-none tracking-[-0.02em] tabular-nums text-foreground/92",
                          beatPriceClass
                        )}>
                          {priceToBeat}
                        </div>
                      </div>
                      <div className="text-[11px] text-muted-foreground/58">
                        Opening reference
                      </div>
                    </div>
                  )}

                  <div className="flex min-h-[98px] min-w-0 flex-col justify-between px-4 py-3">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/65 whitespace-nowrap">
                      {priceToBeat ? 'Current Price' : 'Live Price'}
                    </div>

                    <div className="flex min-h-[40px] items-end pt-1">
                      <div
                        key={livePrice}
                        className={cn(
                          "w-full whitespace-nowrap font-mono font-bold leading-none tracking-[-0.02em] tabular-nums transition-colors duration-300",
                          livePriceClass,
                          direction === 'up' && "animate-price-flash-green",
                          direction === 'down' && "animate-price-flash-red",
                          !direction && priceVsBeat === 'above' && "text-green-400",
                          !direction && priceVsBeat === 'below' && "text-red-400",
                          !direction && !priceVsBeat && "text-foreground",
                        )}
                      >
                        {livePriceLabel}
                      </div>
                    </div>

                    <div className="text-[11px] text-muted-foreground/58">
                      Streaming market reference
                    </div>
                  </div>
                </div>

                <div className="flex min-h-[50px] items-end justify-between gap-4 border-t border-border/30 bg-background/25 px-4 py-2.5">
                  <div className="max-w-[68%] text-[12px] leading-relaxed text-muted-foreground/75">
                    {outcomeLabels.YES} wins if price is <span className="font-medium text-green-400/85">higher</span> at close
                  </div>
                  {livePriceUpdatedAt && (
                    <div className="whitespace-nowrap text-right">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/50">
                        Updated
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground/75">
                        {formatPriceTimestamp(livePriceUpdatedAt)}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {isUpDownMarket && livePrice == null && (
              <p className="text-xs text-muted-foreground mt-1">
                {outcomeLabels.YES} = price goes up • {outcomeLabels.NO} = price goes down
              </p>
            )}
          </div>
        </div>

        {/* Prices & Probabilities */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="h-[82px] rounded-md border border-success/30 bg-success/12 p-3 text-center transition-all duration-300 hover:border-success/50 overflow-hidden">
            <div className={cn(
              "text-xl font-mono font-semibold tabular-nums text-success transition-all duration-300",
              flash === 'up' && "text-green-300",
              flash === 'down' && "text-red-400"
            )}>
              {formatProbability(effectiveProbs.YES)}
            </div>
            <div className="text-xs text-muted-foreground mt-1.5 truncate" title={outcomeLabels.YES}>
              {shortLabels.YES} {effectivePrices && <span className="opacity-75">({formatPrice(effectivePrices.YES)})</span>}
            </div>
          </div>
          <div className="h-[82px] rounded-md border border-border bg-secondary/80 p-3 text-center transition-all duration-300 hover:border-primary/30 overflow-hidden">
            <div className={cn(
              "text-xl font-mono font-semibold tabular-nums transition-all duration-300",
              flash === 'down' && "text-green-300",
              flash === 'up' && "text-red-400"
            )}>
              {formatProbability(effectiveProbs.NO)}
            </div>
            <div className="text-xs text-muted-foreground mt-1.5 truncate" title={outcomeLabels.NO}>
              {shortLabels.NO} {effectivePrices && <span className="opacity-75">({formatPrice(effectivePrices.NO)})</span>}
            </div>
          </div>
        </div>

        {/* Probability bar */}
        <div className="flex h-1.5 rounded-full overflow-hidden bg-muted mb-4">
          <div
            className="bg-green-500 transition-all duration-500 ease-out"
            style={{ width: `${(effectiveProbs.YES * 100).toFixed(1)}%` }}
          />
          <div
            className="bg-muted-foreground/30 transition-all duration-500 ease-out"
            style={{ width: `${(effectiveProbs.NO * 100).toFixed(1)}%` }}
          />
        </div>

        {/* Stats + Countdown */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground mb-4">
          <span>Vol: {market.volume ? formatVolume(market.volume) : '$0'}</span>
          <span>Liq: {market.liquidity ? formatVolume(market.liquidity) : '$0'}</span>
          {countdown && !countdown.expired ? (
            <span className={cn(
              "ml-auto font-mono text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1",
              countdown.isCritical && "bg-red-500/20 text-red-400 animate-pulse",
              countdown.isUrgent && !countdown.isCritical && "bg-amber-500/20 text-amber-400",
              !countdown.isUrgent && "bg-muted text-muted-foreground"
            )}>
              <Clock className="w-3 h-3" />
              {countdown.display}
            </span>
          ) : countdown?.expired ? (
            <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              Ended
            </span>
          ) : market.endDate ? (
            <span className="ml-auto text-xs">
              Ends: {new Date(market.endDate).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
              })}
            </span>
          ) : null}
        </div>

        {/* Actions */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant={yesSelected ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleAdd('YES')}
            disabled={yesSelected}
            className="w-full min-w-0 gap-1.5 text-xs"
            title={`Add ${outcomeLabels.YES}`}
          >
            {yesSelected ? (
              <>
                <Check className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Added</span>
              </>
            ) : (
              <>
                <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{shortLabels.YES}</span>
              </>
            )}
          </Button>
          <Button
            variant={noSelected ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleAdd('NO')}
            disabled={noSelected}
            className="w-full min-w-0 gap-1.5 text-xs"
            title={`Add ${outcomeLabels.NO}`}
          >
            {noSelected ? (
              <>
                <Check className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Added</span>
              </>
            ) : (
              <>
                <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{shortLabels.NO}</span>
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
