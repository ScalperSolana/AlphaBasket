import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ASSET_KIND_LABEL, formatUsd, type IndexAssetKind } from "@/types/index-basket";

export function KindBadge({ kind }: { kind: IndexAssetKind }) {
  return (
    <Badge variant={kind === "perp" ? "perp" : kind === "spot" ? "spot" : "muted"}>
      {ASSET_KIND_LABEL[kind]}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={status === "active" ? "success" : "muted"} className="capitalize">
      {status === "active" && <span className="live-dot" aria-hidden />}
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

/** Gain in green, loss in red, always with a sign so colour is never the only cue. */
export function Pnl({ units, className }: { units: bigint | null; className?: string }) {
  if (units === null) return <span className={cn("text-muted-foreground", className)}>—</span>;
  const tone = units > 0n ? "text-success" : units < 0n ? "text-destructive" : "text-muted-foreground";
  const sign = units > 0n ? "+" : units < 0n ? "−" : "";
  return (
    <span className={cn("tabular-nums", tone, className)}>
      {sign}
      {formatUsd(units < 0n ? -units : units)}
    </span>
  );
}
