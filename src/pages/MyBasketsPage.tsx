import { useWallet } from '@/contexts/WalletContext';
import {
  getBasketsByOwner,
  getFollows,
  getBasketById,
  deleteBasket,
  getBaskets,
} from '@/lib/basket-storage.ts';
import {
  basketIdBytes,
  basketPda,
  fetchOwnerOnchainPositions,
} from '@/lib/solana/escrowProgram.ts';
import { PublicKey } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';
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

  const { myBaskets, followedBaskets } = useMemo(() => {
    if (!address) {
      return { myBaskets: [] as Basket[], followedBaskets: [] as Basket[] };
    }
    const created = getBasketsByOwner(address).sort((a, b) => b.createdAt - a.createdAt);
    const followed = getFollows(address)
      .map((id) => getBasketById(id))
      .filter((b): b is Basket => b !== null);
    return { myBaskets: created, followedBaskets: followed };
  }, [address, refreshKey]);

  // Live on-chain positions (authoritative), mapped back to basket metadata by PDA.
  const { data: positionBaskets = [] } = useQuery<PositionBasket[]>({
    queryKey: ['onchain-positions', address, refreshKey],
    enabled: !!address,
    refetchInterval: 5000,
    queryFn: async () => {
      const owner = new PublicKey(address!);
      const onchain = await fetchOwnerOnchainPositions(owner);
      if (onchain.length === 0) return [];

      // Map basket PDA -> known basket (localStorage holds the string id + markets).
      const pdaToBasket = new Map<string, Basket>();
      for (const b of getBaskets()) {
        const idBytes = await basketIdBytes(b.id);
        pdaToBasket.set(basketPda(idBytes).toBase58(), b);
      }

      const positions: PositionBasket[] = [];
      for (const pos of onchain) {
        if (pos.stakeUsdcUnits <= 0n) continue;
        const basket = pdaToBasket.get(pos.basket.toBase58());
        if (!basket) continue; // basket metadata not stored locally
        positions.push({
          basket,
          stakeUsdcUnits: pos.stakeUsdcUnits,
          claimed: pos.claimed,
          claimRequested: false,
        });
      }
      return positions;
    },
  });

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
