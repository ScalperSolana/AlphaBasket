import { MarketSearch } from '@/components/MarketSearch';
import { useBasket } from '@/contexts/BasketContext';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowRight, Layers } from 'lucide-react';

export default function ExplorePage() {
  // Use basket hook - BasketProvider wraps Routes in App.tsx
  const { items } = useBasket();

  return (
    <>
      <div className="content-grid py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 reveal">
          <div>
            <h1 className="text-3xl md:text-5xl font-display font-bold mb-3 tracking-tight gradient-text">Explore Markets</h1>
            <p className="text-muted-foreground text-base">
              Discover Polymarket predictions and build your basket
            </p>
          </div>
        </div>

        {/* Search & Results */}
        <MarketSearch />
      </div>

      {/* Floating basket button - only shows when items are added */}
      {items.length > 0 && (
        <>
          {/* Desktop: right sidebar area */}
          <div
            className="fixed z-40 hidden lg:block animate-in slide-in-from-right-4 duration-300 bottom-[9%] right-4 md:right-[60px]"
          >
            <Link to="/builder">
              <Button 
                size="lg" 
                className="gap-2 shadow-2xl hover:shadow-xl transition-all border border-primary/30"
              >
                <Layers className="w-5 h-5" />
                {items.length} in basket
                <ArrowRight className="w-5 h-5" />
              </Button>
            </Link>
          </div>

          {/* Mobile: bottom center */}
          <div 
            className="fixed z-40 lg:hidden animate-in slide-in-from-bottom-4 duration-300"
            style={{ bottom: '20px', left: '50%', transform: 'translateX(-50%)' }}
          >
            <Link to="/builder">
              <Button 
                size="lg" 
                className="gap-2 shadow-2xl transition-all border border-primary/30"
              >
                <Layers className="w-5 h-5" />
                {items.length} in basket
                <ArrowRight className="w-5 h-5" />
              </Button>
            </Link>
          </div>
        </>
      )}
    </>
  );
}
