import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, ArrowLeft, Plus, Trash2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MAX_SINGLE_WEIGHT_BPS,
  formatBps,
  validateDraft,
  type DraftLeg,
} from "@/types/index-basket";

/**
 * Phoenix markets offered in the builder.
 *
 * A starting set only. The live catalog comes from Phoenix exchange metadata and
 * moves (76 markets when this was written), so anything hardcoded here is a
 * convenience for the MVP, not the source of truth. The composer's published
 * perp eligibility list is what actually gates a market on chain.
 */
const PERP_MARKETS = ["SOL", "BTC", "ETH", "HYPE", "SUI", "DOGE", "BNB", "XRP"];

const SPOT_TOKENS: ReadonlyArray<{ symbol: string; mint: string }> = [
  { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  { symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
];

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

export default function CreateIndexPage() {
  const [mode, setMode] = useState<"perp" | "spot">("perp");
  const [legs, setLegs] = useState<DraftLeg[]>([]);

  const validation = useMemo(() => validateDraft(legs), [legs]);

  const addLeg = () => {
    const used = new Set(legs.map((leg) => leg.marketId));
    const available =
      mode === "perp"
        ? PERP_MARKETS.filter((market) => !used.has(market))
        : SPOT_TOKENS.filter((token) => !used.has(token.symbol)).map(
            (token) => token.symbol,
          );
    const marketId = available[0] ?? "";
    if (!marketId) return;

    const subaccounts = new Set(
      legs.map((leg) => leg.phoenixSubaccount).filter(Boolean),
    );
    let subaccount = 1;
    while (subaccounts.has(subaccount)) subaccount += 1;

    const next: DraftLeg[] = [
      ...legs,
      {
        id: makeId(),
        kind: mode,
        marketId,
        weightBps: 0,
        ...(mode === "perp"
          ? { direction: "long" as const, leverageBps: 30_000, phoenixSubaccount: subaccount }
          : {
              tokenMint:
                SPOT_TOKENS.find((token) => token.symbol === marketId)?.mint ?? "",
            }),
      },
    ];
    setLegs(rebalance(next));
  };

  const rebalance = (input: DraftLeg[]): DraftLeg[] => {
    const weights = evenWeights(input.length);
    return input.map((leg, i) => ({ ...leg, weightBps: weights[i] ?? 0 }));
  };

  const update = (id: string, patch: Partial<DraftLeg>) =>
    setLegs((current) =>
      current.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg)),
    );

  const remove = (id: string) =>
    setLegs((current) => rebalance(current.filter((leg) => leg.id !== id)));

  const switchMode = (next: "perp" | "spot") => {
    setMode(next);
    // A perp index cannot also hold spot, so switching starts a fresh draft
    // rather than leaving a composition the program would reject.
    setLegs([]);
  };

  return (
    <div className="container max-w-4xl py-8 space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link to="/">
          <ArrowLeft className="h-4 w-4 mr-1.5" />
          All indexes
        </Link>
      </Button>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Create an index</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pick an asset class, add at least four legs, and set weights totalling
          100%.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Asset class</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-3">
          {(
            [
              { id: "perp" as const, label: "Phoenix perps", hint: "Leveraged, isolated margin" },
              { id: "spot" as const, label: "Solana spot", hint: "Unlevered tokens via Jupiter" },
            ]
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => switchMode(option.id)}
              className={`flex-1 rounded-lg border p-4 text-left transition-colors ${
                mode === option.id
                  ? "border-primary bg-primary/5"
                  : "hover:border-muted-foreground/40"
              }`}
            >
              <p className="font-medium">{option.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{option.hint}</p>
            </button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            Legs
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {legs.length} of {16}
            </span>
          </CardTitle>
          <Button size="sm" variant="outline" onClick={addLeg}>
            <Plus className="h-4 w-4 mr-1.5" />
            Add leg
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {legs.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No legs yet. Add at least four.
            </p>
          )}

          {legs.map((leg) => (
            <div
              key={leg.id}
              className="grid gap-3 sm:grid-cols-[1fr_auto] items-end border rounded-lg p-3"
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Market</Label>
                  <Select
                    value={leg.marketId}
                    onValueChange={(value) =>
                      update(leg.id, {
                        marketId: value,
                        ...(leg.kind === "spot"
                          ? {
                              tokenMint:
                                SPOT_TOKENS.find((t) => t.symbol === value)?.mint ??
                                "",
                            }
                          : {}),
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(leg.kind === "perp"
                        ? PERP_MARKETS
                        : SPOT_TOKENS.map((t) => t.symbol)
                      ).map((market) => (
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
                      <Label className="text-xs">Direction</Label>
                      <Select
                        value={leg.direction}
                        onValueChange={(value) =>
                          update(leg.id, { direction: value as "long" | "short" })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="long">Long</SelectItem>
                          <SelectItem value="short">Short</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Leverage</Label>
                      <Select
                        value={String(leg.leverageBps)}
                        onValueChange={(value) =>
                          update(leg.id, { leverageBps: Number(value) })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[10_000, 20_000, 30_000, 50_000].map((bps) => (
                            <SelectItem key={bps} value={String(bps)}>
                              {bps / 10_000}x
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}

                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Weight (max {MAX_SINGLE_WEIGHT_BPS / 100}%)
                  </Label>
                  <Input
                    inputMode="decimal"
                    value={(leg.weightBps / 100).toString()}
                    onChange={(event) => {
                      const percent = Number(event.target.value);
                      update(leg.id, {
                        weightBps: Number.isFinite(percent)
                          ? Math.round(percent * 100)
                          : 0,
                      });
                    }}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                {leg.kind === "perp" && (
                  <Badge variant="outline" className="whitespace-nowrap">
                    sub #{leg.phoenixSubaccount}
                  </Badge>
                )}
                <Button size="icon" variant="ghost" onClick={() => remove(leg.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}

          {legs.length > 0 && (
            <div className="space-y-1.5 pt-2">
              <Progress
                value={Math.min((validation.totalWeightBps / 10_000) * 100, 100)}
              />
              <p className="text-xs text-muted-foreground">
                Weights total {formatBps(validation.totalWeightBps)} of 100.00%
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {legs.length > 0 && !validation.ok && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Not publishable yet</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4 space-y-1 mt-1">
              {validation.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground max-w-md">
          Publishing requires a Composer signature over the composition, so it runs
          through the backend rather than the browser. This builder produces the
          composition; wiring the signing call is the next step.
        </p>
        <Button disabled={!validation.ok}>Publish index</Button>
      </div>
    </div>
  );
}
