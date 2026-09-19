import { Check, Copy, ExternalLink } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ENV } from "@/env";
import { useCopy } from "@/hooks/useCopy";
import { cn } from "@/lib/utils";
import { shortAddress } from "@/types/index-basket";

/**
 * A truncated address that copies on click, with the full value on hover and
 * an explorer link beside it. The explorer targets the accounting cluster, which
 * is where index accounts live.
 */
export function AddressChip({
  address,
  label,
  className,
  chars = 4,
}: {
  address: string;
  /** Screen-reader name for what this address is. */
  label: string;
  className?: string;
  chars?: number;
}) {
  const { copied, copy } = useCopy();
  const cluster = ENV.SOLANA_CLUSTER === "mainnet-beta" ? "" : `?cluster=${ENV.SOLANA_CLUSTER}`;

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => void copy(address)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 font-mono text-xs text-muted-foreground transition-colors duration-100 hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-label={`Copy ${label} ${address}`}
          >
            <span className="tabular-nums">{shortAddress(address, chars)}</span>
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent className="font-mono">{copied ? "Copied" : address}</TooltipContent>
      </Tooltip>
      <a
        href={`${ENV.EXPLORER_URL}/account/${address}${cluster}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-100 hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        aria-label={`View ${label} on explorer`}
      >
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </a>
    </span>
  );
}
