import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ArrowDownRight, ArrowUpRight } from "lucide-react";

import { EmptyState, ErrorState, LoadingState } from "@/components/index/ApiState";
import { InvestPanel } from "@/components/index/InvestPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getIndex } from "@/lib/indexApi";
import {
  ASSET_KIND_LABEL,
  formatBps,
  formatLeverage,
  formatUnits,
  formatUsd,
  shortId,
  type IndexAsset,
  type IndexDetail,
} from "@/types/index-basket";

function LegRow({ leg }: { leg: IndexAsset }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{leg.marketId}</TableCell>
      <TableCell>
        <Badge variant="outline">{ASSET_KIND_LABEL[leg.kind]}</Badge>
      </TableCell>
      <TableCell>
        {leg.kind === "perp" && leg.perp ? (
          <span className="inline-flex items-center gap-1 text-sm">
            {leg.perp.direction === "long" ? (
              <ArrowUpRight className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <ArrowDownRight className="h-3.5 w-3.5 text-red-500" />
            )}
            {leg.perp.direction} {formatLeverage(leg.perp.leverageBps)}
          </span>
        ) : (
          <span className="text-muted-foreground text-sm">—</span>
        )}
      </TableCell>
      <TableCell className="tabular-nums">
        {/* Written by settlement from real post-execution Phoenix state, so it
            reads zero until the first fill lands. */}
        {leg.kind === "perp" && leg.perp
          ? leg.perp.marginPosted === "0"
            ? "not filled"
            : `$${formatUnits(leg.perp.marginPosted)}`
          : "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatBps(leg.weightBps)}
      </TableCell>
    </TableRow>
  );
}

export default function IndexPage() {
  const { address } = useParams<{ address: string }>();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; error: string }
    | { status: "ready"; index: IndexDetail }
  >({ status: "loading" });

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    void getIndex(address).then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { status: "ready", index: result.data }
          : { status: "error", error: result.error },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (state.status === "loading") {
    return (
      <div className="container max-w-5xl py-8">
        <LoadingState label="Loading index" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="container max-w-5xl py-8 space-y-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back
          </Link>
        </Button>
        {state.error === "not_found" ? (
          <EmptyState
            title="No such index"
            description="The indexer has not projected an index at this address. It may not exist, or the indexer may still be catching up."
          />
        ) : (
          <ErrorState error={state.error} />
        )}
      </div>
    );
  }

  const { index } = state;
  const totalWeight = index.items.reduce((sum, leg) => sum + leg.weightBps, 0);

  return (
    <div className="container max-w-5xl py-8 space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link to="/">
          <ArrowLeft className="h-4 w-4 mr-1.5" />
          All indexes
        </Link>
      </Button>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight font-mono">
            {shortId(index.basketId)}
          </h1>
          <p className="text-xs text-muted-foreground font-mono mt-1 break-all">
            {index.address}
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="outline">{index.status}</Badge>
          {index.isPerpetual && <Badge variant="outline">Perpetual</Badge>}
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Share price", value: formatUsd(index.sharePriceUnits) },
          { label: "Gross NAV", value: formatUsd(index.grossNavUnits) },
          {
            label: "Shares outstanding",
            value:
              Number(index.totalSharesOutstanding) === 0
                ? "—"
                : Number(index.totalSharesOutstanding).toLocaleString(),
          },
          { label: "Holders", value: String(index.holderCount) },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="pt-6">
              <p className="text-xs text-muted-foreground">{stat.label}</p>
              <p className="text-xl font-semibold tabular-nums mt-1">
                {stat.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Composition
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                version {index.compositionVersion} · performance fee{" "}
                {formatBps(index.performanceFeeBps)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Position</TableHead>
                  <TableHead>Margin posted</TableHead>
                  <TableHead className="text-right">Weight</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {index.items.map((leg) => (
                  <LegRow key={`${leg.marketId}-${leg.kind}`} leg={leg} />
                ))}
              </TableBody>
            </Table>
            <div className="mt-4 space-y-1.5">
              <Progress value={(totalWeight / 10_000) * 100} />
              <p className="text-xs text-muted-foreground">
                Weights total {formatBps(totalWeight)}
              </p>
            </div>
          </CardContent>
        </Card>

        <InvestPanel index={index} />
      </div>
    </div>
  );
}
