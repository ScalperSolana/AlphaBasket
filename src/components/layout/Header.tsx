import { Plus } from "lucide-react";
import { Link } from "react-router-dom";

import { WalletButton } from "@/components/WalletButton";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ENV } from "@/env";

function Logo() {
  return (
    <span
      className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-glow transition-shadow duration-200 group-hover:shadow-glow-lg"
      aria-hidden
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
        <rect x="2" y="11" width="4" height="7" rx="1" />
        <rect x="8" y="7" width="4" height="11" rx="1" />
        <rect x="14" y="2" width="4" height="16" rx="1" />
      </svg>
    </span>
  );
}

/**
 * One page, so the header carries no navigation: the wordmark returns home,
 * the two actions are creating an index and connecting a wallet, and a small
 * pill says which cluster accounting runs on so nobody mistakes internal
 * testing for production.
 */
export function Header() {
  const cluster = ENV.SOLANA_CLUSTER;

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="content-grid flex h-16 items-center gap-3">
        <Link
          to="/"
          className="group flex items-center gap-2.5 rounded-xl py-1 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Logo />
          <span className="text-base font-bold tracking-tight">AlphaBasket</span>
        </Link>

        {cluster !== "mainnet-beta" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="hidden cursor-default items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning sm:inline-flex">
                <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
                {cluster}
              </span>
            </TooltipTrigger>
            <TooltipContent>Accounting on {cluster}. Capital on mainnet.</TooltipContent>
          </Tooltip>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="outline" className="max-sm:h-10 max-sm:w-10 max-sm:px-0">
            <Link to="/create" aria-label="Create index">
              <Plus aria-hidden />
              <span className="hidden sm:inline">Create index</span>
            </Link>
          </Button>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
