import { useWallet } from "@solana/wallet-adapter-react";
import { AlertCircle, Check, Copy, Plus, Scale, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useCopy } from "@/hooks/useCopy";
import { useRestoreFocus } from "@/hooks/useRestoreFocus";
import { cn } from "@/lib/utils";
import {
  formatBps,
  MAX_LEGS,
  MAX_SINGLE_WEIGHT_BPS,
  MIN_LEGS,
  shortAddress,
  validateDraft,
  type DraftLeg,
} from "@/types/index-basket";

type Mode = "perp" | "spot";

/**
 * Phoenix markets offered in the builder.
 *
 * A starting set only. The live catalog comes from Phoenix exchange metadata and
 * moves, so anything hardcoded here is a convenience for the MVP, not the source
 * of truth. The Composer's published perp eligibility list is what gates a
 * market on chain.
 */
const PERP_MARKETS = ["SOL", "BTC", "ETH", "HYPE", "SUI", "DOGE", "BNB", "XRP"];

/** Well-known Solana mints. The Composer's Jupiter admission check is what gates a token. */
const SPOT_TOKENS: ReadonlyArray<{ symbol: string; mint: string }> = [
  { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  { symbol: "JTO", mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL" },
  { symbol: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" },
  { symbol: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  { symbol: "PYTH", mint: "HZ1JovNiVvGrGNiiYvEozEVjZ58xaU3RKwX8eACQBCt3" },
  { symbol: "mSOL", mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So" },
  { symbol: "jitoSOL", mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn" },
  { symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
];

const LEVERAGE_OPTIONS = [10_000, 15_000, 20_000, 30_000, 50_000];
const FEE_OPTIONS = [0, 500, 1_000, 1_500, 2_000];

let nextId = 0;
const makeId = () => `leg-${(nextId += 1)}`;

const evenWeights = (count: number): number[] => {
  if (count === 0) return [];
  const base = Math.floor(10_000 / count);
  const weights = Array.from({ length: count }, () => base);
  // Give the remainder to the first leg so the total is exactly 10000.
  weights[0] += 10_000 - base * count;
  return weights;
};

const rebalance = (legs: DraftLeg[]): DraftLeg[] => {
  const weights = evenWeights(legs.length);
  return legs.map((leg, i) => ({ ...leg, weightBps: weights[i] ?? 0 }));
};

const percentToBps = (text: string): number => {
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) ? Math.max(0, Math.round(value * 100)) : 0;
};

function ModeOption({
  selected,
  onSelect,
  title,
  hint,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex-1 rounded-xl border p-3.5 text-left transition-[border-color,background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        selected ? "border-primary/60 bg-primary/5 shadow-glow" : "border-border hover:border-muted-foreground/40",
      )}
    >
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </button>
  );
}

/**
 * The index builder, opened over the list.
 *
 * It composes and validates against the program's real bounds. Publishing needs
 * the Composer's Ed25519 signature over the composition, which lives on the
 * backend behind an operator token and never in a browser; so the terminal
 * action here is handing the Composer a finished composition, not a dead
 * "Publish" button.
 */
export function CreatePanel() {
  const navigate = useNavigate();
  const { publicKey } = useWallet();
  const { copied, copy } = useCopy();
  useRestoreFocus();

  const [mode, setMode] = useState<Mode>("spot");
  const [legs, setLegs] = useState<DraftLeg[]>([]);
  const [feeBps, setFeeBps] = useState(1_000);
  const [touched, setTouched] = useState(false);

  const validation = useMemo(() => validateDraft(legs), [legs]);

  const availableMarkets = (exceptId?: string) => {
    const used = new Set(legs.filter((leg) => leg.id !== exceptId).map((leg) => leg.marketId));
    return mode === "perp"
      ? PERP_MARKETS.filter((market) => !used.has(market))
      : SPOT_TOKENS.map((token) => token.symbol).filter((symbol) => !used.has(symbol));
  };

  const addLeg = () => {
    const marketId = availableMarkets()[0];
    if (!marketId || legs.length >= MAX_LEGS) return;
    const subaccounts = new Set(legs.map((leg) => leg.phoenixSubaccount).filter(Boolean));
    let subaccount = 1;
    while (subaccounts.has(subaccount)) subaccount += 1;
    setLegs(
      rebalance([
        ...legs,
        {
          id: makeId(),
          kind: mode,
          marketId,
          weightBps: 0,
          ...(mode === "perp"
            ? { direction: "long" as const, leverageBps: 20_000, phoenixSubaccount: subaccount }
            : { tokenMint: SPOT_TOKENS.find((token) => token.symbol === marketId)?.mint ?? "" }),
        },
      ]),
    );
    setTouched(true);
  };

  const update = (id: string, patch: Partial<DraftLeg>) =>
    setLegs((current) => current.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg)));

  const remove = (id: string) => setLegs((current) => rebalance(current.filter((leg) => leg.id !== id)));

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    // A perp index cannot also hold spot, so switching starts a fresh draft
    // rather than leaving a composition the program would reject.
    setLegs([]);
    setTouched(false);
  };

  const composition = useMemo(
    () => ({
      assetClass: mode,
      creator: publicKey?.toBase58() ?? null,
      performanceFeeBps: feeBps,
      isPerpetual: true,
      legs: legs.map((leg) =>
        leg.kind === "perp"
          ? {
              marketId: leg.marketId,
              direction: leg.direction,
              leverageBps: leg.leverageBps,
              phoenixSubaccount: leg.phoenixSubaccount,
              weightBps: leg.weightBps,
            }
          : { marketId: leg.marketId, tokenMint: leg.tokenMint, weightBps: leg.weightBps },
      ),
    }),
    [feeBps, legs, mode, publicKey],
  );

  const total = validation.totalWeightBps;
  const canAdd = legs.length < MAX_LEGS && availableMarkets().length > 0;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) navigate("/");
      }}
    >
      <SheetContent
        className="p-0"
        aria-describedby="create-description"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-border/60 px-5 pb-5 pr-16 pt-6 sm:px-6">
            <SheetHeader>
              <SheetTitle>Create an index</SheetTitle>
              <SheetDescription id="create-description">
                {MIN_LEGS} to {MAX_LEGS} legs, weights totaling 100%, none above {MAX_SINGLE_WEIGHT_BPS / 100}%.
              </SheetDescription>
            </SheetHeader>
          </div>

          <div className="flex-1 overflow-y-auto scrollbar-subtle">
            <div className="space-y-6 px-5 py-5 sm:px-6">
              <section className="space-y-2" aria-labelledby="asset-class">
                <p id="asset-class" className="text-sm font-semibold">
                  Asset class
                </p>
                <div className="flex gap-3" role="radiogroup" aria-labelledby="asset-class">
                  <ModeOption
                    selected={mode === "spot"}
                    onSelect={() => switchMode("spot")}
                    title="Solana spot"
                    hint="Unleveraged, via Jupiter"
                  />
                  <ModeOption
                    selected={mode === "perp"}
                    onSelect={() => switchMode("perp")}
                    title="Phoenix perps"
                    hint="Leveraged, isolated margin"
                  />
                </div>
              </section>

              <section className="space-y-3" aria-labelledby="legs">
                <div className="flex items-center justify-between gap-3">
                  <p id="legs" className="text-sm font-semibold">
                    Legs
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {legs.length} of {MAX_LEGS}
                    </span>
                  </p>
                  <div className="flex gap-2">
                    {legs.length > 1 && (
                      <Button type="button" size="sm" variant="ghost" onClick={() => setLegs(rebalance(legs))}>
                        <Scale aria-hidden />
                        Split evenly
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="outline" onClick={addLeg} disabled={!canAdd}>
                      <Plus aria-hidden />
                      Add leg
                    </Button>
                  </div>
                </div>

                {legs.length === 0 && (
                  <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
                    <p className="text-sm font-medium">No legs yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">Add at least {MIN_LEGS}. Weights split evenly.</p>
                    <Button type="button" size="sm" className="mt-4" onClick={addLeg}>
                      <Plus aria-hidden />
                      Add first leg
                    </Button>
                  </div>
                )}

                <ul className="space-y-2">
                  {legs.map((leg, position) => (
                    <li key={leg.id} className="rounded-xl border border-border/70 bg-background/40 p-3">
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                        <div className={cn("grid gap-3", leg.kind === "perp" ? "sm:grid-cols-4" : "sm:grid-cols-2")}>
                          <div className="space-y-1.5">
                            <Label htmlFor={`${leg.id}-market`} className="text-xs text-muted-foreground">
                              Market
                            </Label>
                            <Select
                              value={leg.marketId}
                              onValueChange={(value) =>
                                update(leg.id, {
                                  marketId: value,
                                  ...(leg.kind === "spot"
                                    ? { tokenMint: SPOT_TOKENS.find((t) => t.symbol === value)?.mint ?? "" }
                                    : {}),
                                })
                              }
                            >
                              <SelectTrigger id={`${leg.id}-market`} className="h-10" aria-label={`Market for leg ${position + 1}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {availableMarkets(leg.id).map((market) => (
                                  <SelectItem key={market} value={market}>
                                    {market}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          {leg.kind === "perp" && (
                            <>
                              <div className="space-y-1.5">
                                <Label htmlFor={`${leg.id}-direction`} className="text-xs text-muted-foreground">
                                  Direction
                                </Label>
                                <Select
                                  value={leg.direction}
                                  onValueChange={(value) => update(leg.id, { direction: value as "long" | "short" })}
                                >
                                  <SelectTrigger id={`${leg.id}-direction`} className="h-10" aria-label={`Direction for leg ${position + 1}`}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="long">Long</SelectItem>
                                    <SelectItem value="short">Short</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-1.5">
                                <Label htmlFor={`${leg.id}-leverage`} className="text-xs text-muted-foreground">
                                  Leverage
                                </Label>
                                <Select
                                  value={String(leg.leverageBps)}
                                  onValueChange={(value) => update(leg.id, { leverageBps: Number(value) })}
                                >
                                  <SelectTrigger id={`${leg.id}-leverage`} className="h-10" aria-label={`Leverage for leg ${position + 1}`}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {LEVERAGE_OPTIONS.map((bps) => (
                                      <SelectItem key={bps} value={String(bps)}>
                                        {(bps / 10_000).toFixed(1).replace(/\.0$/, "")}x
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            </>
                          )}

                          <div className="space-y-1.5">
                            <Label htmlFor={`${leg.id}-weight`} className="text-xs text-muted-foreground">
                              Weight
                            </Label>
                            <div className="relative">
                              <Input
                                id={`${leg.id}-weight`}
                                inputMode="decimal"
                                autoComplete="off"
                                className="h-10 pr-8 tabular-nums"
                                value={(leg.weightBps / 100).toString()}
                                onChange={(event) => update(leg.id, { weightBps: percentToBps(event.target.value) })}
                                aria-invalid={leg.weightBps > MAX_SINGLE_WEIGHT_BPS || leg.weightBps <= 0 || undefined}
                              />
                              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                                %
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center justify-end gap-2">
                          {leg.kind === "perp" && (
                            <Badge variant="muted" className="font-mono">
                              sub #{leg.phoenixSubaccount}
                            </Badge>
                          )}
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => remove(leg.id)}
                            aria-label={`Remove ${leg.marketId}`}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>

                {legs.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <Progress
                      value={Math.min((total / 10_000) * 100, 100)}
                      aria-label="Total weight"
                      indicatorClassName={total === 10_000 ? "bg-success" : total > 10_000 ? "bg-destructive" : "bg-primary"}
                    />
                    <p className={cn("text-xs tabular-nums", total === 10_000 ? "text-success" : "text-muted-foreground")}>
                      Weights total {formatBps(total)} of 100%
                    </p>
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <Label htmlFor="performance-fee">Creator performance fee</Label>
                <Select value={String(feeBps)} onValueChange={(value) => setFeeBps(Number(value))}>
                  <SelectTrigger id="performance-fee" className="h-10 sm:w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FEE_OPTIONS.map((bps) => (
                      <SelectItem key={bps} value={String(bps)}>
                        {formatBps(bps)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </section>

              {touched && legs.length > 0 && !validation.ok && (
                <Alert variant="warning">
                  <AlertCircle />
                  <AlertTitle>Fix before publishing</AlertTitle>
                  <AlertDescription>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {validation.problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {validation.ok && (
                <Alert variant="info">
                  <Check />
                  <AlertTitle>Ready for the Composer</AlertTitle>
                  <AlertDescription>
                    Publishing needs the Composer's signature, which runs on the backend. Copy the composition to hand it over.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </div>

          <div className="border-t border-border/60 px-5 py-4 sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                {publicKey ? (
                  <>
                    Creator <span className="font-mono">{shortAddress(publicKey.toBase58())}</span>
                  </>
                ) : (
                  "Connect a wallet to set the creator."
                )}
              </p>
              <Button
                type="button"
                disabled={!validation.ok}
                onClick={() => void copy(JSON.stringify(composition, null, 2))}
                aria-live="polite"
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                {copied ? "Copied" : "Copy composition"}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
