import { useRef, useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, Twitter, Send, X, TrendingUp, TrendingDown, CheckCircle } from 'lucide-react';
import { toPng } from 'html-to-image';
import { getMarketDetails } from '@/lib/polymarket.ts';

interface MarketItem {
  question: string;
  slug?: string;
  marketId?: string;
  outcome: 'YES' | 'NO';
  weightBps: number;
}

interface MarketDetails {
  question: string;
  description?: string;
  endDate?: string;
  image?: string;
  slug?: string;
}

interface PayoutCelebrationProps {
  isOpen: boolean;
  onClose: () => void;
  payoutAmount: string;
  basketName: string;
  basketId: number;
  markets: MarketItem[];
  indexAtCreation: number;
  settlementIndex: number;
  currency: 'USDC' | 'wUSDC';
  txHash?: string;
}

export function PayoutCelebration({
  isOpen,
  onClose,
  payoutAmount,
  basketName,
  basketId,
  markets,
  indexAtCreation,
  settlementIndex,
  currency,
  txHash,
}: PayoutCelebrationProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [marketDetails, setMarketDetails] = useState<Map<string, MarketDetails>>(new Map());

  const profitMultiplier = indexAtCreation > 0 ? settlementIndex / indexAtCreation : 1;
  const isProfitable = profitMultiplier >= 1;
  const profitPercent = ((profitMultiplier - 1) * 100).toFixed(1);

  // Fetch detailed market info in background
  useEffect(() => {
    if (!isOpen || markets.length === 0) return;
    
    const fetchDetails = async () => {
      const details = new Map<string, MarketDetails>();
      
      await Promise.all(
        markets.map(async (market) => {
          const id = market.marketId || market.slug;
          if (!id) return;
          
          try {
            const data = await getMarketDetails(id);
            if (data) {
              details.set(id, {
                question: data.question || market.question,
                description: data.description,
                endDate: data.endDate,
                image: data.image,
                slug: data.slug || market.slug,
              });
            }
          } catch (e) {
            console.warn(`Failed to fetch market details for ${id}`);
          }
        })
      );
      
      if (details.size > 0) {
        setMarketDetails(details);
      }
    };
    
    fetchDetails();
  }, [isOpen, markets]);

  // Get market info - uses fetched details if available, fallback to basic data
  const getMarketInfo = (market: MarketItem): MarketDetails => {
    const id = market.marketId || market.slug;
    
    // Check if we have fetched details
    if (id && marketDetails.has(id)) {
      return marketDetails.get(id)!;
    }
    
    // Fallback to basic data
    let question = market.question;
    if (!question || question.length <= 3 || question.startsWith('val-')) {
      // Clean up slug as fallback
      if (market.slug) {
        question = market.slug
          .replace(/-/g, ' ')
          .replace(/\b\w/g, l => l.toUpperCase())
          .replace(/\d{4}\s\d{2}\s\d{2}/g, '')
          .trim();
      } else {
        question = 'Prediction Market';
      }
    }
    
    return { question, slug: market.slug };
  };

  const handleDownload = async () => {
    if (!cardRef.current) return;
    
    try {
      const dataUrl = await toPng(cardRef.current, {
        backgroundColor: 'hsl(220, 25%, 8%)', // matches --background
        pixelRatio: 2,
      });
      
      const link = document.createElement('a');
      link.download = `polybaskets-payout-${basketId}.png`;
      link.href = dataUrl;
      link.click();
    } catch (error) {
      console.error('Failed to download image:', error);
    }
  };

  const shareText = isProfitable 
    ? `🎉 Just claimed ${payoutAmount} ${currency} from my "${basketName}" basket on @PolyBaskets!

📊 ${markets.length} markets in basket
📈 ${profitPercent}% profit
💰 Settlement: ${(settlementIndex * 100).toFixed(1)}%

Build your prediction basket 👇`
    : `📊 Claimed ${payoutAmount} ${currency} from my "${basketName}" basket on @PolyBaskets

${markets.length} markets in basket
📉 ${Math.abs(parseFloat(profitPercent))}% loss
Entry: ${(indexAtCreation * 100).toFixed(1)}% → Settlement: ${(settlementIndex * 100).toFixed(1)}%

Next time! Build your basket 👇`;

  const handleShareTwitter = () => {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent('http://www.polybaskets.xyz/')}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const handleShareTelegram = () => {
    const url = `https://t.me/share/url?url=${encodeURIComponent('http://www.polybaskets.xyz/')}&text=${encodeURIComponent(shareText)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="hide-default-close sm:max-w-[520px] p-0 gap-0 bg-transparent border-0 shadow-none overflow-visible">
        <div className="relative">
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute -top-3 -right-3 z-50 w-9 h-9 rounded-full bg-card border border-border flex items-center justify-center hover:bg-muted transition-colors shadow-lg"
          >
            <X className="w-4 h-4 text-white/70" />
          </button>

          {/* Main Card */}
          <div
            ref={cardRef}
            className="relative overflow-hidden rounded-3xl bg-background"
            style={{
              boxShadow: isProfitable 
                ? '0 0 80px hsl(120 100% 50% / 0.15), 0 25px 50px -12px rgb(0 0 0 / 0.5)'
                : '0 0 80px hsl(0 100% 50% / 0.15), 0 25px 50px -12px rgb(0 0 0 / 0.5)',
            }}
          >
            {/* Decorative top glow */}
            <div 
              className="absolute top-0 left-1/2 -translate-x-1/2 w-[300px] h-[200px] opacity-[0.08] blur-[80px] rounded-full"
              style={{ backgroundColor: isProfitable ? 'hsl(120,100%,50%)' : 'hsl(0,100%,50%)' }}
            />
            
            {/* Header */}
            <div className="relative pt-8 pb-4 text-center">
              {/* Icon */}
              <div className="relative inline-flex items-center justify-center mb-4">
                <div 
                  className="absolute inset-0 w-20 h-20 rounded-full blur-xl"
                  style={{ backgroundColor: isProfitable ? 'hsl(120,100%,50%,0.2)' : 'hsl(0,100%,50%,0.2)' }}
                />
                <div 
                  className="relative w-16 h-16 rounded-full flex items-center justify-center shadow-lg"
                  style={{ 
                    background: isProfitable 
                      ? 'linear-gradient(to bottom right, hsl(120,100%,50%), hsl(120,80%,40%))'
                      : 'linear-gradient(to bottom right, hsl(0,100%,50%), hsl(0,80%,40%))',
                    boxShadow: isProfitable 
                      ? '0 0 30px hsl(120 100% 50% / 0.4)'
                      : '0 0 30px hsl(0 100% 50% / 0.4)',
                  }}
                >
                  <CheckCircle className="w-9 h-9 text-white" strokeWidth={2.5} />
                </div>
              </div>

              {/* Logo */}
              <div className="flex items-center justify-center gap-1.5 mb-2">
                <div 
                  className="w-5 h-5 rounded flex items-center justify-center"
                  style={{ backgroundColor: isProfitable ? 'hsl(120,100%,50%,0.2)' : 'hsl(0,100%,50%,0.2)' }}
                >
                  <span 
                    className="text-[10px] font-bold"
                    style={{ color: isProfitable ? 'hsl(120,100%,50%)' : 'hsl(0,100%,50%)' }}
                  >P</span>
                </div>
                <span className="text-sm font-semibold text-white/80">PolyBaskets</span>
              </div>

              {/* Main text */}
              <h2 
                className="text-3xl font-bold mb-1"
                style={{
                  background: isProfitable 
                    ? 'linear-gradient(135deg, hsl(120 100% 55%) 0%, hsl(120 100% 70%) 100%)'
                    : 'linear-gradient(135deg, hsl(0 100% 55%) 0%, hsl(0 100% 70%) 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                {isProfitable ? 'You won' : 'You received'} {payoutAmount} {currency}
              </h2>
              <p className="text-white/50 text-sm">
                {isProfitable 
                  ? 'Great job predicting the future!' 
                  : `Loss: ${Math.abs(parseFloat(profitPercent))}% of your position`}
              </p>
            </div>

            {/* Basket Visual */}
            <div className="relative px-6 pb-6">
              {/* Basket container with weave pattern */}
              <div 
                className="relative rounded-2xl overflow-hidden"
                style={{
                  background: 'linear-gradient(180deg, #1a1510 0%, #0d0a07 100%)',
                  border: '2px solid #3d2a14',
                }}
              >
                {/* Basket weave pattern overlay */}
                <div 
                  className="absolute inset-0 opacity-20"
                  style={{
                    backgroundImage: `
                      repeating-linear-gradient(90deg, #8B4513 0px, #8B4513 2px, transparent 2px, transparent 12px),
                      repeating-linear-gradient(0deg, #8B4513 0px, #8B4513 2px, transparent 2px, transparent 12px)
                    `,
                  }}
                />
                
                {/* Basket rim */}
                <div 
                  className="h-3 w-full"
                  style={{
                    background: 'linear-gradient(180deg, #5d3a1a 0%, #3d2a14 50%, #2d1a0a 100%)',
                    borderBottom: '1px solid #2d1a0a',
                  }}
                />

                {/* Basket name header */}
                <div className="relative px-4 pt-3 pb-2 border-b border-[#3d2a14]/50">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[10px] text-[#c4a574] uppercase tracking-wider font-medium">Basket</div>
                      <div className="text-lg font-bold text-white">{basketName}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-[#c4a574] uppercase tracking-wider">ID</div>
                      <div className="text-sm font-mono text-white/70">#{basketId}</div>
                    </div>
                  </div>
                </div>

                {/* Markets inside basket */}
                <div className="relative p-4 space-y-3">
                  {markets.map((market, idx) => {
                    const info = getMarketInfo(market);
                    const isYes = market.outcome === 'YES';
                    
                    return (
                      <div 
                        key={idx}
                        className="p-3 rounded-xl bg-black/40 border border-white/5"
                      >
                        {/* Header row with outcome and weight */}
                        <div className="flex items-start gap-3 mb-2">
                          {/* Market icon/indicator */}
                          <div 
                            className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                              isYes 
                                ? 'bg-[hsl(120,100%,50%)]/15 border border-[hsl(120,100%,50%)]/30' 
                                : 'bg-red-500/15 border border-red-500/30'
                            }`}
                          >
                            <CheckCircle 
                              className={`w-5 h-5 ${isYes ? 'text-[hsl(120,100%,50%)]' : 'text-red-400'}`} 
                            />
                          </div>
                          
                          {/* Market question */}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-white font-semibold leading-snug">
                              {info.question}
                            </div>
                          </div>
                          
                          {/* Outcome & Weight badges */}
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className={`text-xs font-bold px-2 py-1 rounded ${
                              isYes 
                                ? 'bg-[hsl(120,100%,50%)]/20 text-[hsl(120,100%,50%)]' 
                                : 'bg-red-500/20 text-red-400'
                            }`}>
                              {market.outcome}
                            </span>
                            <span className="text-xs font-mono text-white/50 bg-white/5 px-2 py-1 rounded">
                              {(market.weightBps / 100).toFixed(0)}%
                            </span>
                          </div>
                        </div>
                        
                      </div>
                    );
                  })}
                </div>

                {/* Stats row */}
                <div className="relative px-4 pb-4">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="p-3 rounded-xl bg-black/40 border border-white/5 text-center">
                      <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Entry</div>
                      <div className="text-lg font-bold tabular-nums text-white">
                        {(indexAtCreation * 100).toFixed(1)}%
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-black/40 border border-white/5 text-center">
                      <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Settlement</div>
                      <div className={`text-lg font-bold tabular-nums ${isProfitable ? 'text-[hsl(120,100%,50%)]' : 'text-red-400'}`}>
                        {(settlementIndex * 100).toFixed(1)}%
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-black/40 border border-white/5 text-center">
                      <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Return</div>
                      <div className={`text-lg font-bold tabular-nums flex items-center justify-center gap-1 ${
                        isProfitable ? 'text-[hsl(120,100%,50%)]' : 'text-red-400'
                      }`}>
                        {isProfitable ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                        {profitMultiplier.toFixed(2)}x
                      </div>
                    </div>
                  </div>
                </div>

                {/* Basket bottom rim */}
                <div 
                  className="h-4 w-full"
                  style={{
                    background: 'linear-gradient(180deg, #2d1a0a 0%, #3d2a14 50%, #5d3a1a 100%)',
                    borderTop: '1px solid #5d3a1a',
                  }}
                />
              </div>
            </div>

            {/* Footer */}
            <div className="relative px-6 pb-6 text-center">
              <div className="text-[11px] text-white/30">
                polybaskets • Prediction Market Baskets
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="mt-4 flex gap-3">
            <Button
              onClick={handleDownload}
              variant="outline"
              className="flex-1 h-11 bg-card border-border hover:bg-muted text-white"
            >
              <Download className="w-4 h-4 mr-2" />
              Download
            </Button>
            <Button
              onClick={handleShareTwitter}
              className="flex-1 h-11 bg-secondary hover:bg-secondary/80 text-white border border-border"
            >
              <Twitter className="w-4 h-4 mr-2" />
              Share on X
            </Button>
            <Button
              onClick={handleShareTelegram}
              className="flex-1 h-11 bg-[#0088cc] hover:bg-[#0077b5] text-white border-0"
            >
              <Send className="w-4 h-4 mr-2" />
              Telegram
            </Button>
          </div>

          {/* Transaction hash */}
          {txHash && (
            <div className="mt-3 text-center">
              <span className="text-xs text-white/40">
                TX: <span className="font-mono text-white/60">{txHash.slice(0, 12)}...{txHash.slice(-8)}</span>
              </span>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
