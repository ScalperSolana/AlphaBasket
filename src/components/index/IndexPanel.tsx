import { useWallet } from "@solana/wallet-adapter-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { AddressChip } from "@/components/index/AddressChip";
import { EmptyState, ErrorState } from "@/components/index/ApiState";
import { KindBadge, Pnl, StatusBadge } from "@/components/index/badges";
import { InvestPanel, type InvestSide } from "@/components/index/InvestPanel";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useRestoreFocus } from "@/hooks/useRestoreFocus";
import { getIndex, getPortfolio, type ApiResult } from "@/lib/indexApi";
import { pnlUnits } from "@/lib/pnl";
import { cn } from "@/lib/utils";
import {
  ASSET_KIND_LABEL,
  formatBps,
  formatLeverage,
  formatShares,
  formatUnits,
  formatUsd,
  shortAddress,
  shortId,
  type IndexAsset,
  type IndexDetail,
  type IndexSummary,
  type PortfolioHolding,
} from "@/types/index-basket";

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="surface surface-interactive p-4">
      <p className="stat-label">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Stats({ index, className }: { index: IndexDetail; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3", className)}>
      <StatTile
        label="Share price"
        value={index.sharePriceUnits === null ? "Unpriced" : formatUsd(index.sharePriceUnits)}
        hint={index.sharePriceUnits === null ? "First deposit sets $1.00" : undefined}
      />
      <StatTile label="Net asset value" value={formatUsd(index.grossNavUnits)} />
      <StatTile
        label="Shares outstanding"
        value={index.totalSharesOutstanding === "0" ? "—" : formatShares(index.totalSharesOutstanding)}
      />
      <StatTile label="Holders" value={String(index.holderCount)} />
    </div>
  );
}

function YourPosition({ holding, onWithdraw }: { holding: PortfolioHolding; onWithdraw: () => void }) {
  return (
    <section className="surface p-5" aria-labelledby="your-position">
      <div className="flex items-center justify-between gap-3">
        <h3 id="your-position" className="text-sm font-semibold">
          Your position
        </h3>
        <Button variant="outline" size="sm" onClick={onWithdraw}>
          Withdraw
        </Button>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <div>
          <dt className="stat-label">Shares</dt>
          <dd className="mt-0.5 font-semibold tabular-nums">{formatShares(holding.sharesOwned)}</dd>
        </div>
        <div>
          <dt className="stat-label">Value</dt>
          <dd className="mt-0.5 font-semibold tabular-nums">{formatUsd(holding.currentValueUnits)}</dd>
        </div>
        <div>
          <dt className="stat-label">Cost basis</dt>
          <dd className="mt-0.5 font-semibold tabular-nums">{formatUsd(holding.costBasisValue)}</dd>
        </div>
        <div>
          <dt className="stat-label">P&amp;L</dt>
          <dd className="mt-0.5 font-semibold">
            <Pnl units={pnlUnits(holding)} />
          </dd>
        </div>
      </dl>
    </section>
  );
}

function LegRow({ leg, order }: { leg: IndexAsset; order: number }) {
  const perp = leg.kind === "perp" ? leg.perp : undefined;
  return (
    <li className="group -mx-2 rounded-xl px-2 py-3 transition-colors duration-150 hover:bg-secondary/40">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="font-semibold">{leg.marketId}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            {perp ? (
              <>
                <span className={cn("inline-flex items-center gap-0.5 font-medium", perp.direction === "long" ? "text-success" : "text-destructive")}>
                  {perp.direction === "long" ? (
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {perp.direction === "long" ? "Long" : "Short"} {formatLeverage(perp.leverageBps)}
                </span>
                <span aria-hidden>·</span>
                <span>sub #{perp.phoenixSubaccount}</span>
                <span aria-hidden>·</span>
                {/* Written by settlement from real Phoenix state; zero until the first fill lands. */}
                <span className="tabular-nums">
                  {perp.marginPosted === "0" ? "unfilled" : `$${formatUnits(perp.marginPosted)} margin`}
                </span>
              </>
            ) : leg.tokenMint ? (
              <span className="font-mono">{shortAddress(leg.tokenMint, 6)}</span>
            ) : leg.kind === "prediction_market" ? (
              <span
                className={cn(
                  "font-medium",
                  leg.outcome === 0 ? "text-success" : leg.outcome === 1 ? "text-destructive" : undefined,
                )}
              >
                {leg.outcome === 0 ? "Yes" : leg.outcome === 1 ? "No" : ASSET_KIND_LABEL[leg.kind]}
              </span>
            ) : (
              <span>{ASSET_KIND_LABEL[leg.kind]}</span>
            )}
          </p>
        </div>
        <p className="shrink-0 text-sm font-semibold tabular-nums transition-colors duration-150 group-hover:text-primary">
          {formatBps(leg.weightBps)}
        </p>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className="h-full origin-left animate-grow-x rounded-full bg-primary/70 transition-[background-color] duration-150 group-hover:bg-primary group-hover:shadow-glow"
          style={{ width: `${leg.weightBps / 100}%`, animationDelay: `${order * 60}ms` }}
        />
      </div>
    </li>
  );
}

function Composition({ index }: { index: IndexDetail }) {
  const total = index.items.reduce((sum, leg) => sum + leg.weightBps, 0);
  return (
    <section className="surface p-5" aria-labelledby="composition">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="composition" className="text-sm font-semibold">
          Composition
        </h3>
        <p className="text-xs text-muted-foreground tabular-nums">
          v{index.compositionVersion} · {formatBps(total)}
        </p>
      </div>
      <ul className="mt-3 divide-y divide-border/60">
        {index.items.map((leg, order) => (
          <LegRow key={`${leg.marketId}-${leg.kind}`} leg={leg} order={order} />
        ))}
      </ul>
    </section>
  );
}

function PanelSkeleton() {
  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_288px]" aria-busy="true">
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px] rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
      <Skeleton className="h-80 rounded-2xl" />
    </div>
  );
}

/**
 * An index, opened over the list.
 *
 * Route-driven so `/index/:address` deep links, the browser back button closes
 * it, and the list underneath keeps its scroll position and filters.
 */
export function IndexPanel() {
  const { address = "" } = useParams<{ address: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { publicKey } = useWallet();
  const owner = publicKey?.toBase58() ?? null;

  useRestoreFocus();

  const [side, setSide] = useState<InvestSide>(params.get("side") === "withdraw" ? "withdraw" : "deposit");
  useEffect(() => {
    if (params.get("side") === "withdraw") setSide("withdraw");
  }, [params]);

  // The list already knows the summary, so the header renders instantly while
  // the composition loads.
  const summary = (queryClient.getQueryData(["indexes"]) as ApiResult<readonly IndexSummary[]> | undefined)?.data?.find(
    (candidate) => candidate.address === address,
  );

  const detail = useQuery({
    queryKey: ["index", address],
    queryFn: () => getIndex(address),
    enabled: address.length > 0,
  });
  const portfolio = useQuery({
    queryKey: ["portfolio", owner],
    queryFn: () => getPortfolio(owner as string),
    enabled: owner !== null,
  });

  const index = detail.data?.ok ? detail.data.data : undefined;
  const head: IndexSummary | undefined = index ?? summary;
  const holding = portfolio.data?.ok ? portfolio.data.data.find((h) => h.basketAddress === address) ?? null : null;

  const close = () => navigate("/");

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent
        className="p-0 sm:w-[min(100vw-2rem,820px)]"
        aria-describedby="index-description"
        // Focus the panel itself rather than its first control: auto-focusing
        // the address chip opened its tooltip on every open.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-border/60 px-5 pb-5 pr-16 pt-6 sm:px-6">
            <SheetHeader>
              <div className="flex flex-wrap items-center gap-1.5">
                {head?.assetKinds.map((kind) => (
                  <KindBadge key={kind} kind={kind} />
                ))}
                {head && <StatusBadge status={head.status} />}
              </div>
              <SheetTitle className="font-mono text-2xl">{head ? shortId(head.basketId) : "Index"}</SheetTitle>
              <SheetDescription id="index-description">
                {head
                  ? `${head.itemCount} legs · ${head.isPerpetual ? "open-ended" : "resolving"} · ${formatBps(head.performanceFeeBps)} creator fee on profit`
                  : "Loading"}
              </SheetDescription>
              <AddressChip address={address} label="index address" className="-ml-2" chars={6} />
            </SheetHeader>
          </div>

          <div className="flex-1 overflow-y-auto scrollbar-subtle">
            <div className="px-5 py-5 sm:px-6">
              {detail.isPending && <PanelSkeleton />}

              {detail.data && !detail.data.ok && detail.data.code === "not_found" && (
                <EmptyState
                  title="No index at this address"
                  description="It may not exist yet, or the indexer is still catching up."
                  action={
                    <Button variant="outline" onClick={close}>
                      Back to indexes
                    </Button>
                  }
                />
              )}
              {detail.data && !detail.data.ok && detail.data.code !== "not_found" && (
                <ErrorState title="Could not load this index" error={detail.data.error} onRetry={() => void detail.refetch()} />
              )}

              {index && (
                <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_300px] md:items-start">
                  <Stats index={index} className="md:col-start-1 md:row-start-1" />
                  <div className="md:sticky md:top-0 md:col-start-2 md:row-span-2 md:row-start-1">
                    <InvestPanel
                      index={index}
                      holding={holding}
                      side={side}
                      onSideChange={(next) => {
                        setSide(next);
                        if (params.has("side")) setParams({}, { replace: true });
                      }}
                    />
                  </div>
                  <div className="space-y-5 md:col-start-1 md:row-start-2">
                    {holding && <YourPosition holding={holding} onWithdraw={() => setSide("withdraw")} />}
                    <Composition index={index} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
