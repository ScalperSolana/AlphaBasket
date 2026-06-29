import { useMemo } from 'react';
import { useBasket } from '@/contexts/BasketContext';
import { calculateBasketIndex, formatChange, getChangeClass } from '@/lib/basket-utils.ts';
import { formatProbability, formatPrice } from '@/lib/polymarket.ts';
import { OutcomeProbabilities } from '@/types/polymarket.ts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendingUp, Clock, Layers, BarChart3 } from 'lucide-react';

interface BasketIndexProps {
  marketProbabilities?: Map<string, OutcomeProbabilities>;
  marketPrices?: Map<string, { YES: number; NO: number }>;
  previousIndex?: number;
}

export function BasketIndex({ marketProbabilities, marketPrices, previousIndex }: BasketIndexProps) {
  const { items } = useBasket();

  const currentIndex = useMemo(() => {
    if (!marketProbabilities || items.length === 0) return 0;
    return calculateBasketIndex(items, marketProbabilities);
  }, [items, marketProbabilities]);

  const change = previousIndex !== undefined ? currentIndex - previousIndex : 0;

  if (items.length === 0) {
    return (
      <Card className="card-elevated">
        <CardContent className="py-8 text-center">
          <div className="flex justify-center mb-2">
            <div className="p-3 rounded-full bg-muted/60 inline-flex">
              <BarChart3 className="w-8 h-8 text-muted-foreground" />
            </div>
          </div>
          <p className="text-muted-foreground">
            Add markets to your basket to see the live index
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="card-elevated overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <TrendingUp className="w-4 h-4" />
          Basket Index
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Main Index */}
        <div className="flex items-baseline gap-3">
          <span className="index-display">{currentIndex.toFixed(3)}</span>
          {previousIndex !== undefined && (
            <span className={`stat-chip ${getChangeClass(change)}`}>
              {formatChange(change)} 1h
            </span>
          )}
        </div>

        {/* Stats Row */}
        <div className="flex items-center gap-3 text-sm">
          <span className="stat-chip stat-chip-neutral">
            <Layers className="w-3 h-3" />
            {items.length} items
          </span>
          <span className="stat-chip stat-chip-neutral">
            <Clock className="w-3 h-3" />
            Live
          </span>
        </div>

        {/* Components Table */}
        <div className="border rounded-lg divide-y">
          <div className="grid grid-cols-5 gap-2 px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/50 font-mono">
            <span className="col-span-2">Outcome</span>
            <span className="text-right">Weight</span>
            <span className="text-right">Price</span>
            <span className="text-right">Prob</span>
          </div>
          {items.map((item, index) => {
            const prob = item.currentProb ?? 0.5;
            const prices = marketPrices?.get(item.marketId);
            const price = prices ? (item.outcome === 'YES' ? prices.YES : prices.NO) : null;
            return (
              <div key={`${item.marketId}-${item.outcome}`} className="grid grid-cols-5 gap-2 px-3 py-2 text-sm">
                <span className="col-span-2 break-words" title={item.question}>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full mr-2 ${
                    item.outcome === 'YES' ? 'bg-success shadow-[0_0_6px_hsl(120_100%_45%)]' : 'bg-muted-foreground'
                  }`} />
                  {item.question}
                </span>
                <span className="text-right tabular-nums text-muted-foreground">
                  {(item.weightBps / 100).toFixed(1)}%
                </span>
                <span className="text-right tabular-nums font-medium">
                  {price !== null ? formatPrice(price) : '-'}
                </span>
                <span className="text-right tabular-nums font-medium">
                  {formatProbability(prob)}
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
