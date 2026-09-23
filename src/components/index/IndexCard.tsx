import { Link, useParams } from "react-router-dom";

import { KindBadge, StatusBadge } from "@/components/index/badges";
import { cn } from "@/lib/utils";
import { formatBps, formatShares, formatUsd, shortId, type IndexSummary } from "@/types/index-basket";

export function IndexCard({ index, order = 0 }: { index: IndexSummary; order?: number }) {
  const { address } = useParams<{ address: string }>();
  const selected = address === index.address;

  return (
    <Link
      to={`/index/${index.address}`}
      aria-current={selected ? "true" : undefined}
      style={{ animationDelay: `${Math.min(order, 8) * 40}ms` }}
      className={cn(
        "surface surface-interactive group block animate-rise-in p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        selected && "border-primary/60 shadow-glow-ring",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {index.assetKinds.map((kind) => (
            <KindBadge key={kind} kind={kind} />
          ))}
        </div>
        <StatusBadge status={index.status} />
      </div>

      <div className="mt-4">
        <p className="font-mono text-base font-semibold tracking-tight transition-colors duration-150 group-hover:text-primary">
          {shortId(index.basketId)}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {index.itemCount} legs · v{index.compositionVersion} · {formatBps(index.performanceFeeBps)} fee
        </p>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <dt className="stat-label">Share price</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">
            {index.sharePriceUnits === null ? (
              <span className="text-muted-foreground">Unpriced</span>
            ) : (
              formatUsd(index.sharePriceUnits)
            )}
          </dd>
        </div>
        <div>
          <dt className="stat-label">NAV</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">
            {index.grossNavUnits === null ? <span className="text-muted-foreground">—</span> : formatUsd(index.grossNavUnits)}
          </dd>
        </div>
        <div>
          <dt className="stat-label">Shares out</dt>
          <dd className="mt-0.5 text-sm tabular-nums">
            {index.totalSharesOutstanding === "0" ? "—" : formatShares(index.totalSharesOutstanding)}
          </dd>
        </div>
        <div>
          <dt className="stat-label">Structure</dt>
          <dd className="mt-0.5 text-sm">{index.isPerpetual ? "Open-ended" : "Resolving"}</dd>
        </div>
      </dl>
    </Link>
  );
}
