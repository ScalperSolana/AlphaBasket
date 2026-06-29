import { useWallet } from '@/contexts/WalletContext';
import {
  getBasketsByOwner,
  getFollows,
  getBasketById,
  deleteBasket,
  getPositionsByOwner,
} from '@/lib/basket-storage.ts';
import { fromUsdcUnits } from '@/lib/solana/usdc.ts';
import { BasketCard } from '@/components/BasketCard';
import { WalletButton } from '@/components/WalletButton';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Link } from 'react-router-dom';
import { Wallet as WalletIcon, Plus, Heart, Layers, RefreshCw, TicketCheck } from 'lucide-react';
import { useState, useMemo } from 'react';
import { useToast } from '@/hooks/use-toast';
import type { Basket } from '@/types/basket.ts';

type PositionBasket = {
  basket: Basket;
  stakeUsdcUnits: bigint;
  claimed: boolean;
  claimRequested: boolean;
};

export default function MyBasketsPage() {
  const { address } = useWallet();
  const { toast } = useToast();
  const [deletingBasketId, setDeletingBasketId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const { myBaskets, followedBaskets, positionBaskets } = useMemo(() => {
    if (!address) {
      return { myBaskets: [], followedBaskets: [], positionBaskets: [] as PositionBasket[] };
    }

    const created = getBasketsByOwner(address).sort((a, b) => b.createdAt - a.createdAt);

    const followed = getFollows(address)
      .map((id) => getBasketById(id))
      .filter((b): b is Basket => b !== null);

    // Group off-chain positions by basket.
    const byBasket = new Map<string, { units: bigint; claimed: boolean; requested: boolean }>();
    for (const p of getPositionsByOwner(address)) {
      const prev = byBasket.get(p.basketId) ?? { units: 0n, claimed: true, requested: false };
      byBasket.set(p.basketId, {
        units: prev.units + BigInt(p.stakeUsdcUnits),
        claimed: prev.claimed && p.claimed,
        requested: prev.requested || Boolean(p.claimRequestedAt),
      });
    }

    const positions: PositionBasket[] = [];
    byBasket.forEach((value, basketId) => {
      const basket = getBasketById(basketId);
      if (basket && value.units > 0n) {
        positions.push({
          basket,
          stakeUsdcUnits: value.units,
          claimed: value.claimed,
          claimRequested: value.requested,
        });
      }
    });

    return { myBaskets: created, followedBaskets: followed, positionBaskets: positions };
  }, [address, refreshKey]);

  const handleRefresh = () => setRefreshKey((prev) => prev + 1);

  const handleDeleteBasket = (basketId: string, basketName: string) => {
    if (window.confirm(`Delete "${basketName}"? This removes it from your local view.`)) {
      setDeletingBasketId(basketId);
      try {
        if (deleteBasket(basketId)) {
          toast({ title: 'Basket Deleted', description: `"${basketName}" was removed.` });
          handleRefresh();
        } else {
          toast({ title: 'Delete Failed', description: 'Could not delete the basket.', variant: 'destructive' });
        }
      } finally {
        setDeletingBasketId(null);
      }
    }
  };

  if (!address) {
    return (
      <div className="content-grid py-8">
        <div className="text-center py-16">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
            <WalletIcon className="w-8 h-8 text-muted-foreground" />
          </div>
          <h1 className="text-2xl font-semibold mb-2">Connect Wallet</h1>
          <p className="text-muted-foreground mb-6">Connect your wallet to see your baskets and follows</p>
          <div className="flex justify-center">
            <WalletButton />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="content-grid py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl md:text-5xl font-display font-normal mb-3 tracking-tight gradient-text reveal">My Baskets</h1>
          <p className="text-muted-foreground text-base reveal reveal-delay-1">
            Manage your positions, created baskets and follows
            <span className="ml-2 text-xs opacity-75">(Live updates)</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} className="gap-2">
            <RefreshCw className="w-4 h-4" />
            Refresh
          </Button>
          <Link to="/builder">
            <Button className="gap-2">
              <Plus className="w-4 h-4" />
              Create Basket
            </Button>
          </Link>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="created" className="space-y-6">
        <TabsList>
          <TabsTrigger value="created" className="gap-2">
            <Layers className="w-4 h-4" />
            Created ({myBaskets.length})
          </TabsTrigger>
          <TabsTrigger value="following" className="gap-2">
            <Heart className="w-4 h-4" />
            Following ({followedBaskets.length})
          </TabsTrigger>
          <TabsTrigger value="positions" className="gap-2">
            <TicketCheck className="w-4 h-4" />
            Positions ({positionBaskets.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="created">
          {myBaskets.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground mb-2">You haven't created any baskets yet</p>
                <p className="text-sm text-muted-foreground/70 mb-4">Create your first basket to get started</p>
                <Link to="/builder">
                  <Button variant="outline">Create Basket</Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {myBaskets.map((basket, index) => (
                <BasketCard
                  key={`${basket.id}-${index}`}
                  basket={basket}
                  onDelete={basket.owner === address ? () => handleDeleteBasket(basket.id, basket.name) : undefined}
                  isDeleting={deletingBasketId === basket.id}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="following">
          {followedBaskets.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground mb-4">You're not following any baskets yet</p>
                <Link to="/explorer">
                  <Button variant="outline">Explore Markets</Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {followedBaskets.map((basket) => (
                <BasketCard key={basket.id} basket={basket} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="positions">
          {positionBaskets.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground mb-2">You don't have any basket positions yet</p>
                <p className="text-sm text-muted-foreground/70 mb-4">
                  Baskets you stake on will appear here even if you did not create them.
                </p>
                <Link to="/explorer">
                  <Button variant="outline">Explore Markets</Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {positionBaskets.map(({ basket, stakeUsdcUnits, claimed, claimRequested }) => (
                <div key={basket.id} className="space-y-3">
                  <BasketCard basket={basket} />
                  <Card className="border-border/60">
                    <CardContent className="space-y-3 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm text-muted-foreground">Your stake</div>
                        <div className="font-mono text-sm">{fromUsdcUnits(stakeUsdcUnits)} USDC</div>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm text-muted-foreground">Status</div>
                        <Badge variant="secondary">
                          {claimed ? 'Claimed' : claimRequested ? 'Claim Requested' : 'Active'}
                        </Badge>
                      </div>
                      <Link to={`/basket/${basket.id}`}>
                        <Button className="w-full" variant="outline">
                          Open Basket
                        </Button>
                      </Link>
                    </CardContent>
                  </Card>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
