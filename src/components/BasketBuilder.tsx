import { useBasket } from '@/contexts/BasketContext';
import { formatWeight } from '@/lib/basket-utils.ts';
import { formatPrice, formatProbability } from '@/lib/polymarket.ts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Trash2, Scale, AlertCircle } from 'lucide-react';

interface BasketBuilderProps {
  marketPrices?: Map<string, { YES: number; NO: number }>;
  marketProbabilities?: Map<string, { YES: number; NO: number }>;
}

export function BasketBuilder({ marketPrices, marketProbabilities }: BasketBuilderProps) {
  const {
    items,
    name,
    description,
    setName,
    setDescription,
    updateWeight,
    removeItem,
    normalizeAllWeights,
  } = useBasket();

  const totalWeight = items.reduce((sum, item) => sum + item.weightBps, 0);
  const isValid = totalWeight === 10000;
  const parseWeightInput = (value: string) => Number.parseFloat(value.replace(',', '.')) || 0;

  return (
    <Card className="card-elevated">
      <CardHeader className="pb-4">
        <CardTitle className="text-lg font-semibold">Basket Details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Name & Description */}
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1.5 block">Name</label>
            <Input
              placeholder="My Prediction Basket"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={48}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">Description</label>
            <Input
              placeholder="A brief description of your thesis..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={160}
            />
          </div>
        </div>

        {/* Weight Summary */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
          <span className="text-sm">
            Total Weight: 
            <span className={`ml-2 font-semibold tabular-nums ${isValid ? 'text-accent' : 'text-destructive'}`}>
              {(totalWeight / 100).toFixed(1)}%
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={normalizeAllWeights}
            className="gap-1.5"
            disabled={items.length === 0}
          >
            <Scale className="w-3.5 h-3.5" />
            Normalize
          </Button>
        </div>

        {!isValid && items.length > 0 && (
          <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-lg">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            Weights must sum to 100%
          </div>
        )}

        {/* Items */}
        {items.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <p>No items in basket</p>
            <p className="text-sm mt-1">Search and add markets from the Explore page</p>
          </div>
        ) : (
          <div className="space-y-4">
            {items.map((item) => (
              <div
                key={`${item.marketId}-${item.outcome}`}
                className="border rounded-lg p-4 space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                        item.outcome === 'YES' 
                          ? 'bg-accent/10 text-accent' 
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {item.outcome}
                      </span>
                    </div>
                    <p className="text-sm font-medium break-words" title={item.question}>
                      {item.question}
                    </p>
                    {/* Show price if available */}
                    {(() => {
                      const prices = marketPrices?.get(item.marketId);
                      const probs = marketProbabilities?.get(item.marketId);
                      if (prices) {
                        const price = item.outcome === 'YES' ? prices.YES : prices.NO;
                        const prob = probs ? (item.outcome === 'YES' ? probs.YES : probs.NO) : item.currentProb ?? 0.5;
                        return (
                          <p className="text-xs text-muted-foreground mt-1">
                            {formatPrice(price)} ({formatProbability(prob)})
                          </p>
                        );
                      }
                      return null;
                    })()}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => removeItem(item.marketId, item.outcome)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-4">
                  <Slider
                    value={[item.weightBps]}
                    onValueChange={([value]) => updateWeight(item.marketId, item.outcome, value)}
                    max={10000}
                    step={100}
                    className="flex-1 min-h-[44px] flex items-center"
                  />
                  <div className="flex shrink-0 items-center gap-3">
                    <Input
                      type="number"
                      value={(item.weightBps / 100).toFixed(1)}
                      onChange={(e) => {
                        const value = parseWeightInput(e.target.value);
                        updateWeight(item.marketId, item.outcome, Math.round(value * 100));
                      }}
                      className="w-28 text-right tabular-nums"
                      min={0}
                      max={100}
                      step={0.1}
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
