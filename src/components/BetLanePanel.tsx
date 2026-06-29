import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAnchorWallet } from '@solana/wallet-adapter-react';
import { Coins, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useWallet } from '@/contexts/WalletContext';
import { useToast } from '@/hooks/use-toast';
import { AgentTradingNotice } from '@/components/AgentTradingNotice';
import { ENV, isManualBettingEnabled } from '@/env';
import { Position } from '@/types/basket.ts';
import {
  addPosition,
  getOwnerPositionForBasket,
  markPositionsClaimRequested,
} from '@/lib/basket-storage.ts';
import { toUsdcUnits, fromUsdcUnits } from '@/lib/solana/usdc.ts';
import {
  basketIdBytes,
  ensureBasket,
  stakeWithQuote,
  claimPosition,
} from '@/lib/solana/escrowProgram.ts';
import { getSignedQuote, isQuoteApiConfigured } from '@/lib/solana/quoteApi.ts';

type BetLanePanelProps = {
  basketId: string | null;
  basketStatus: 'Active' | 'SettlementPending' | 'Settled' | null | undefined;
  /** Current live basket index in bps — entry index for new bets. */
  entryIndexBps?: number | null;
  /** Settlement index in bps once the basket settles, else null. */
  settlementIndexBps?: number | null;
  settlementFinalized?: boolean;
};

type BettingPhase = 'idle' | 'betting';

export function BetLanePanel({
  basketId,
  basketStatus,
  entryIndexBps = null,
  settlementIndexBps = null,
  settlementFinalized = false,
}: BetLanePanelProps) {
  const { address, connect } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const manualBettingEnabled = isManualBettingEnabled();
  const [betAmount, setBetAmount] = useState('');
  const [bettingPhase, setBettingPhase] = useState<BettingPhase>('idle');
  const [claiming, setClaiming] = useState(false);

  const quoteConfigured = isQuoteApiConfigured() || !!ENV.DEV_QUOTE_SIGNER_SECRET;

  const position = useMemo<Position | null>(
    () => (address && basketId ? getOwnerPositionForBasket(address, basketId) : null),
    [address, basketId, bettingPhase, claiming],
  );

  const stakeUnits = position ? BigInt(position.stakeUsdcUnits) : 0n;
  const hasPosition = stakeUnits > 0n;
  const claimed = position?.claimed ?? false;
  const claimRequested = Boolean(position?.claimRequestedAt);

  const expectedPayoutUnits = useMemo(() => {
    if (!position || !hasPosition || settlementIndexBps === null) {
      return null;
    }
    if (settlementIndexBps === 0) return 0n;
    const entry = position.indexAtCreationBps > 0 ? position.indexAtCreationBps : 1;
    return (stakeUnits * BigInt(settlementIndexBps)) / BigInt(entry);
  }, [position, hasPosition, settlementIndexBps, stakeUnits]);

  const canClaim = basketId !== null && settlementFinalized && hasPosition && !claimed;

  const parsedBetUnits = useMemo(() => {
    if (!betAmount.trim()) return null;
    try {
      return toUsdcUnits(betAmount);
    } catch {
      return null;
    }
  }, [betAmount]);

  const handlePlaceBet = async () => {
    if (!manualBettingEnabled) {
      toast({
        title: 'Agent-Only Execution',
        description: 'USDC betting is available through your agent only.',
        variant: 'destructive',
      });
      return;
    }
    if (!address || !anchorWallet) {
      await connect();
      return;
    }
    if (basketId === null) return;
    if (basketStatus !== 'Active') {
      toast({
        title: 'Basket Not Active',
        description: 'USDC bets are only available while the basket is active.',
        variant: 'destructive',
      });
      return;
    }
    if (!parsedBetUnits || parsedBetUnits <= 0n) {
      toast({ title: 'Invalid Amount', description: 'Enter a valid USDC amount.', variant: 'destructive' });
      return;
    }
    if (!entryIndexBps || entryIndexBps < 1) {
      toast({
        title: 'Index Unavailable',
        description: 'Live basket index is not available yet. Try again in a moment.',
        variant: 'destructive',
      });
      return;
    }
    if (!quoteConfigured) {
      toast({
        title: 'Configuration Error',
        description: 'Quote signer is not configured (set VITE_QUOTE_API_URL).',
        variant: 'destructive',
      });
      return;
    }

    setBettingPhase('betting');
    try {
      const idBytes = await basketIdBytes(basketId);
      await ensureBasket(anchorWallet, idBytes);
      const quote = await getSignedQuote({
        basketIdBytes: idBytes,
        owner: anchorWallet.publicKey,
        entryIndexBps,
      });
      const signature = await stakeWithQuote(anchorWallet, idBytes, parsedBetUnits, quote);

      addPosition({
        basketId,
        owner: address,
        stakeUsdcUnits: parsedBetUnits.toString(),
        indexAtCreationBps: entryIndexBps,
        txSignature: signature,
        createdAt: Date.now(),
        claimed: false,
      });

      toast({ title: 'USDC Bet Placed', description: `${betAmount} USDC staked on this basket.` });
      setBetAmount('');
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to place USDC bet';
      toast({ title: 'USDC Bet Failed', description: message, variant: 'destructive' });
    } finally {
      setBettingPhase('idle');
    }
  };

  const handleClaim = async () => {
    if (!address || !anchorWallet || basketId === null) {
      await connect();
      return;
    }
    if (!canClaim) {
      toast({
        title: 'Claim Not Available',
        description: 'Payout can be claimed after the basket is finalized.',
        variant: 'destructive',
      });
      return;
    }

    setClaiming(true);
    try {
      // The program pays out by formula from the basket vault, trustlessly.
      const idBytes = await basketIdBytes(basketId);
      await claimPosition(anchorWallet, idBytes);
      markPositionsClaimRequested(address, basketId);

      toast({
        title: 'Payout Claimed',
        description: 'Your USDC payout was transferred from the basket vault.',
      });
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to claim payout';
      toast({ title: 'Claim Failed', description: message, variant: 'destructive' });
    } finally {
      setClaiming(false);
    }
  };

  const isBetting = bettingPhase !== 'idle';
  const actionDisabled =
    !manualBettingEnabled ||
    !quoteConfigured ||
    isBetting ||
    basketId === null ||
    basketStatus !== 'Active' ||
    !betAmount.trim() ||
    !parsedBetUnits ||
    parsedBetUnits <= 0n;

  const expectedPayoutDisplay = expectedPayoutUnits === null ? null : fromUsdcUnits(expectedPayoutUnits);

  return (
    <>
      {basketStatus === 'Active' &&
        (manualBettingEnabled ? (
          <Card className="card-elevated border-border/60">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Coins className="w-4 h-4 text-[#14F195]" />
                Bet on Basket
              </CardTitle>
              {hasPosition && (
                <CardDescription>Your stake: {fromUsdcUnits(stakeUnits)} USDC</CardDescription>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <Input
                  type="number"
                  inputMode="decimal"
                  placeholder="Enter USDC amount"
                  value={betAmount}
                  onChange={(event) => setBetAmount(event.target.value)}
                  min="0"
                  step="0.01"
                />
                <Button
                  onClick={address ? handlePlaceBet : connect}
                  disabled={address ? actionDisabled : false}
                  className="w-full gap-2"
                  size="lg"
                >
                  {isBetting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Coins className="w-4 h-4" />}
                  {address ? (isBetting ? 'Placing USDC...' : 'Place Bet') : 'Connect Wallet'}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <AgentTradingNotice description="USDC betting is available through your agent only." />
        ))}

      <Card className={`card-elevated ${manualBettingEnabled && canClaim ? 'border-accent' : 'border-border/60'}`}>
        <CardHeader>
          <CardTitle className="text-base">Claim Payout</CardTitle>
          <CardDescription>
            {manualBettingEnabled
              ? canClaim
                ? `Settlement is finalized. Claim ${expectedPayoutDisplay ?? '0'} USDC.`
                : !hasPosition
                  ? address
                    ? 'You do not have a position in this basket yet.'
                    : 'Connect your wallet to check your position.'
                  : !settlementFinalized
                    ? 'Payout unlocks after the basket settlement is finalized.'
                    : claimed
                      ? 'You have already claimed this payout.'
                      : 'No payout is available yet.'
              : 'USDC payout claiming is available through your agent only.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {hasPosition && (
            <div className="rounded-lg border bg-muted/20 p-3 space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Stake</span>
                <span className="font-medium">{fromUsdcUnits(stakeUnits)} USDC</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Entry index</span>
                <span className="font-medium">
                  {(Number(position?.indexAtCreationBps || 0) / 100).toFixed(2)}%
                </span>
              </div>
              {expectedPayoutDisplay !== null && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Expected payout</span>
                  <span className="font-medium">{expectedPayoutDisplay} USDC</span>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Status</span>
                <Badge variant={claimed ? 'default' : 'secondary'}>
                  {claimed ? 'Claimed' : claimRequested ? 'Claiming' : 'Open'}
                </Badge>
              </div>
            </div>
          )}

          {manualBettingEnabled && canClaim ? (
            <Button
              onClick={handleClaim}
              disabled={claiming}
              className="w-full gap-2"
              variant={expectedPayoutUnits && expectedPayoutUnits > 0n ? 'default' : 'secondary'}
            >
              {claiming ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Claiming...
                </>
              ) : (
                <>
                  <Coins className="w-4 h-4" />
                  {expectedPayoutUnits === 0n ? 'Finalize Position' : `Claim ${expectedPayoutDisplay ?? '0'} USDC`}
                </>
              )}
            </Button>
          ) : !manualBettingEnabled ? (
            <AgentTradingNotice description="USDC payout claiming is available through your agent only." />
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
