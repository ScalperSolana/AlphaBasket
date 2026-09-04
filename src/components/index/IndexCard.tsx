import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  ASSET_KIND_LABEL,
  formatBps,
  formatUsd,
  shortId,
  type IndexSummary,
} from "@/types/index-basket";

const kindTone: Record<string, string> = {
  perp: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  spot: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  prediction_market: "bg-violet-500/15 text-violet-400 border-violet-500/30",
};

const statusTone = (status: string): string =>
  status === "active"
    ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
    : "bg-muted text-muted-foreground";

export function IndexCard({ index }: { index: IndexSummary }) {
  return (
    <Link to={`/index/${index.address}`} className="block group">
      <Card className="h-full transition-colors group-hover:border-primary/50">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-mono text-sm truncate">{shortId(index.basketId)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {index.itemCount} legs · v{index.compositionVersion}
              </p>
            </div>
            <Badge variant="outline" className={statusTone(index.status)}>
              {index.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {index.assetKinds.map((kind) => (
              <Badge key={kind} variant="outline" className={kindTone[kind]}>
                {ASSET_KIND_LABEL[kind]}
              </Badge>
            ))}
            {index.isPerpetual && (
              <Badge variant="outline" className="text-muted-foreground">
                Perpetual
              </Badge>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Share price</dt>
              <dd className="font-medium tabular-nums">
                {formatUsd(index.sharePriceUnits)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">NAV</dt>
              <dd className="font-medium tabular-nums">
                {formatUsd(index.grossNavUnits)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Perf. fee</dt>
              <dd className="font-medium tabular-nums">
                {formatBps(index.performanceFeeBps)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Shares out</dt>
              <dd className="font-medium tabular-nums">
                {Number(index.totalSharesOutstanding) === 0
                  ? "—"
                  : Number(index.totalSharesOutstanding).toLocaleString()}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </Link>
  );
}
