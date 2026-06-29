import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAnchorWallet } from '@solana/wallet-adapter-react';
import { useBasket } from '@/contexts/BasketContext';
import { useWallet } from '@/contexts/WalletContext';
import { useNetwork } from '@/contexts/NetworkContext';
import { generateBasketId, saveBasket, addPosition } from '@/lib/basket-storage.ts';
import { Basket, Position } from '@/types/basket.ts';
import { createSnapshot, validateBasket } from '@/lib/basket-utils.ts';
import { OutcomeProbabilities } from '@/types/polymarket.ts';
import { calculateBetAllocationFromUsdc, formatUsdc } from '@/lib/betCalculator.ts';
import { toUsdcUnits } from '@/lib/solana/usdc.ts';
import { basketIdBytes, ensureBasket, stakeWithQuote } from '@/lib/solana/escrowProgram.ts';
import { getSignedQuote, isQuoteApiConfigured } from '@/lib/solana/quoteApi.ts';
import { ENV, isManualBettingEnabled } from '@/env';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Save, Circle, CheckCircle2, Clock } from 'lucide-react';
import { getBetCutoffMs, formatBetCutoff, isEndTimestampBettable } from '@/lib/betCutoff';

interface SaveBasketButtonProps {
  marketProbabilities: Map<string, OutcomeProbabilities>;
  marketPrices?: Map<string, { YES: number; NO: number }>;
}

type TxStatus = 'idle' | 'submitted' | 'finalized';

const BASKET_BET_CUTOFF_MS = getBetCutoffMs();
const BASKET_BET_CUTOFF_LABEL = formatBetCutoff(BASKET_BET_CUTOFF_MS);

const parseAmountInput = (value: string): number => Number.parseFloat(value.replace(',', '.'));

export function SaveBasketButton({ marketProbabilities, marketPrices }: SaveBasketButtonProps) {
  const navigate = useNavigate();
  const { items, name, description, tags, clearBasket } = useBasket();
  const { address, connect } = useWallet();
  const { network, config } = useNetwork();
  const anchorWallet = useAnchorWallet();
  const { toast } = useToast();
  const manualBettingEnabled = isManualBettingEnabled();
  const didAutofillDefaultBetRef = useRef(false);

  const [status, setStatus] = useState<TxStatus>('idle');
  const [betAmount, setBetAmount] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (items.length === 0) {
      return;
    }
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [items.length]);

  // Auto-fill a default stake when the basket first gets items.
  useEffect(() => {
    if (items.length === 0) {
      didAutofillDefaultBetRef.current = false;
      return;
    }
    if (!didAutofillDefaultBetRef.current && !betAmount) {
      setBetAmount('10');
      didAutofillDefaultBetRef.current = true;
    }
  }, [items.length, betAmount]);

  const cutoffBlockedItem = useMemo(
    () =>
      items.find((item) => {
        const endTimestamp = Number(item.endTimestamp);
        return (
          Number.isFinite(endTimestamp) &&
          !isEndTimestampBettable(endTimestamp, nowMs, BASKET_BET_CUTOFF_MS)
        );
      }) ?? null,
    [items, nowMs],
  );
  const cutoffBlockedMarketLabel =
    cutoffBlockedItem?.question || cutoffBlockedItem?.slug || cutoffBlockedItem?.marketId || 'one selected market';

  const errors = validateBasket(items, name);
  const isValid = errors.length === 0;

  const betAmountNum = betAmount ? parseAmountInput(betAmount) : 0;
  const isValidBetAmount = betAmountNum > 0 && !Number.isNaN(betAmountNum);

  const betCalculation = useMemo(() => {
    if (!isValidBetAmount || items.length === 0) {
      return null;
    }
    try {
      return calculateBetAllocationFromUsdc(betAmountNum, items, marketPrices);
    } catch (error) {
      console.error('Error calculating bet allocation:', error);
      return null;
    }
  }, [betAmountNum, isValidBetAmount, items, marketPrices]);

  const quoteConfigured = isQuoteApiConfigured() || !!ENV.DEV_QUOTE_SIGNER_SECRET;

  const disabledReason =
    !manualBettingEnabled ? 'Manual basket creation is disabled in this deployment.' :
    cutoffBlockedItem ? `${cutoffBlockedMarketLabel} ends in less than ${BASKET_BET_CUTOFF_LABEL}. Remove it or choose another market.` :
    !isValid ? errors[0] :
    !isValidBetAmount ? 'Enter a valid USDC amount.' :
    !quoteConfigured ? 'Quote signer is not configured (set VITE_QUOTE_API_URL).' :
    status !== 'idle' ? 'Wait for the current transaction to finish.' :
    null;

  const isSaveDisabled =
    !manualBettingEnabled ||
    !!cutoffBlockedItem ||
    !isValid ||
    !isValidBetAmount ||
    !quoteConfigured ||
    status !== 'idle';

  const handleSave = async () => {
    if (!manualBettingEnabled) {
      toast({
        title: 'Agent-Only Execution',
        description: 'Basket creation is available through your agent only.',
        variant: 'destructive',
      });
      return;
    }

    if (!address || !anchorWallet) {
      await connect();
      return;
    }

    if (cutoffBlockedItem) {
      toast({
        title: 'Market Too Close To End',
        description: `${cutoffBlockedMarketLabel} ends in less than ${BASKET_BET_CUTOFF_LABEL}. Remove it or choose another market.`,
        variant: 'destructive',
      });
      return;
    }

    if (!isValid) {
      toast({ title: 'Invalid Basket', description: errors[0], variant: 'destructive' });
      return;
    }

    if (!isValidBetAmount) {
      toast({ title: 'Invalid Stake', description: 'Enter a valid USDC amount.', variant: 'destructive' });
      return;
    }

    if (!quoteConfigured) {
      toast({
        title: 'Configuration Error',
        description: 'Quote signer is not configured. Set VITE_QUOTE_API_URL.',
        variant: 'destructive',
      });
      return;
    }

    // Validate every item is still bettable before signing.
    for (const item of items) {
      const endTimestamp = Number(item.endTimestamp);
      if (Number.isFinite(endTimestamp) && !isEndTimestampBettable(endTimestamp, Date.now(), BASKET_BET_CUTOFF_MS)) {
        toast({
          title: 'Market Too Close To End',
          description: `Market "${item.question || item.slug || item.marketId}" ends in less than ${BASKET_BET_CUTOFF_LABEL}.`,
          variant: 'destructive',
        });
        return;
      }
    }

    const basketId = generateBasketId();
    const snapshot = createSnapshot(items, marketProbabilities);
    const indexAtCreationBps = Math.max(1, Math.min(10000, Math.round(snapshot.basketIndex * 10000)));

    try {
      setStatus('submitted');
      const amountUnits = toUsdcUnits(betAmount);
      const idBytes = await basketIdBytes(basketId);

      // Create the basket + vault on-chain if needed, fetch a signed entry-index
      // quote, then stake (Ed25519 verify + stake in one tx).
      await ensureBasket(anchorWallet, idBytes);
      const quote = await getSignedQuote({
        basketIdBytes: idBytes,
        owner: anchorWallet.publicKey,
        entryIndexBps: indexAtCreationBps,
      });
      toast({ title: 'Confirm in your wallet', description: `Staking ${betAmountNum.toFixed(2)} USDC...` });
      const signature = await stakeWithQuote(anchorWallet, idBytes, amountUnits, quote);

      const basket: Basket = {
        id: basketId,
        owner: address,
        name,
        description,
        tags,
        createdAt: Date.now(),
        items,
        createdSnapshot: snapshot,
        network,
        assetKind: 'USDC',
        status: 'Active',
      };
      saveBasket(basket);

      const position: Position = {
        basketId,
        owner: address,
        stakeUsdcUnits: amountUnits.toString(),
        indexAtCreationBps,
        txSignature: signature,
        createdAt: Date.now(),
        claimed: false,
      };
      addPosition(position);

      setStatus('finalized');
      toast({
        title: 'Basket Created & Staked!',
        description: `"${name}" funded with ${betAmountNum.toFixed(2)} USDC at index ${(indexAtCreationBps / 100).toFixed(2)}%.`,
      });

      clearBasket();
      setTimeout(() => navigate(`/basket/${basketId}`), 500);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong. Please try again.';
      console.error('Failed to create basket:', error);
      toast({ title: 'Creation Failed', description: message, variant: 'destructive' });
      setStatus('idle');
    }
  };

  const getStatusDisplay = () => {
    switch (status) {
      case 'submitted':
        return (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Staking...
          </>
        );
      case 'finalized':
        return (
          <>
            <CheckCircle2 className="w-4 h-4" />
            Done ✓
          </>
        );
      default:
        return (
          <>
            <Save className="w-4 h-4" />
            Stake on {config.name}
          </>
        );
    }
  };

  return (
    <div className="space-y-4">
      {/* Stake Amount Input */}
      <div className="space-y-2">
        <Label htmlFor="bet-amount" className="text-sm font-medium">
          Stake Amount (USDC)
        </Label>
        <Input
          id="bet-amount"
          type="number"
          placeholder="0.0"
          value={betAmount}
          onChange={(e) => setBetAmount(e.target.value)}
          min="0"
          step="0.1"
          disabled={status !== 'idle'}
          className="w-full"
        />
        {betCalculation && betCalculation.allocations.length > 0 && (
          <div className="bg-muted/50 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Total:</span>
              <span className="font-semibold">{formatUsdc(betCalculation.totalUsdc)}</span>
            </div>
            <div className="mt-2 pt-2 border-t border-border/50">
              <div className="text-xs text-muted-foreground mb-1">Allocation by market (based on weights):</div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {betCalculation.allocations.map((alloc, idx) => {
                  const item = items.find((i) => i.marketId === alloc.marketId);
                  return (
                    <div key={idx} className="flex items-center justify-between text-xs">
                      <span className="truncate flex-1" title={item?.question}>
                        {item?.question?.slice(0, 30)}...
                      </span>
                      <span className="ml-2 font-medium tabular-nums">{alloc.usdcAmount.toFixed(2)} USDC</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Save Button */}
      <Button onClick={handleSave} disabled={isSaveDisabled} className="w-full gap-2" size="lg">
        {!address ? (
          <>
            <Save className="w-4 h-4" />
            Connect Wallet
          </>
        ) : manualBettingEnabled ? (
          getStatusDisplay()
        ) : (
          <>
            <Circle className="w-4 h-4" />
            Agent Only
          </>
        )}
      </Button>
      {!manualBettingEnabled && (
        <p className="text-xs text-muted-foreground">
          Basket creation from the web UI is disabled. Send the create-and-stake flow through your agent.
        </p>
      )}
      {disabledReason && <p className="text-sm text-muted-foreground">{disabledReason}</p>}

      {status !== 'idle' && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          {status === 'submitted' ? <Clock className="w-3 h-3" /> : <Circle className="w-2 h-2 fill-[#14F195] text-[#14F195]" />}
          {config.name}
        </div>
      )}
    </div>
  );
}
