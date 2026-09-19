import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Search, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, Outlet } from "react-router-dom";

import { EmptyState, ErrorState, IndexGridSkeleton, RowsSkeleton } from "@/components/index/ApiState";
import { KindBadge, Pnl } from "@/components/index/badges";
import { IndexCard } from "@/components/index/IndexCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getPortfolio, listIndexes } from "@/lib/indexApi";
import { pnlUnits } from "@/lib/pnl";
import { formatShares, formatUsd, shortId, type IndexAssetKind } from "@/types/index-basket";

type Filter = "all" | IndexAssetKind;

function PortfolioSection() {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const owner = publicKey?.toBase58() ?? null;

  const portfolio = useQuery({
    queryKey: ["portfolio", owner],
    queryFn: () => getPortfolio(owner as string),
    enabled: owner !== null,
  });

  const holdings = portfolio.data?.ok ? portfolio.data.data : undefined;
  const totals = useMemo(() => {
    if (!holdings) return null;
    let value = 0n;
    let pnl = 0n;
    for (const holding of holdings) {
      value += BigInt(holding.currentValueUnits ?? holding.costBasisValue);
      pnl += pnlUnits(holding) ?? 0n;
    }
    return { value, pnl };
  }, [holdings]);

  return (
    <section aria-labelledby="positions-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="positions-heading" className="text-lg font-semibold tracking-tight">
            Your positions
          </h2>
        </div>
        {totals && holdings && holdings.length > 0 && (
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-semibold tabular-nums">{formatUsd(totals.value)}</span>
            <Pnl units={totals.pnl} className="text-sm font-medium" />
          </div>
        )}
      </div>

      {owner === null && (
        <div className="surface flex flex-col items-start gap-4 p-5 sm:flex-row sm:items-center">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
            <Wallet className="h-4 w-4" aria-hidden />
          </div>
          <p className="flex-1 text-sm font-medium">Connect a wallet to see your positions</p>
          <Button variant="outline" onClick={() => setVisible(true)}>
            Connect wallet
          </Button>
        </div>
      )}

      {owner !== null && portfolio.isPending && <RowsSkeleton rows={2} />}

      {owner !== null && portfolio.data && !portfolio.data.ok && (
        <ErrorState
          title="Could not load your positions"
          error={portfolio.data.error}
          onRetry={() => void portfolio.refetch()}
        />
      )}

      {holdings && holdings.length === 0 && (
        <EmptyState
          title="No positions yet"
          description="Open an index below to make a first deposit."
        />
      )}

      {holdings && holdings.length > 0 && (
        <div className="surface px-5 py-2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Index</TableHead>
                <TableHead className="hidden sm:table-cell">Holds</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Shares</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="text-right">P&amp;L</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {holdings.map((holding) => (
                <TableRow key={holding.basketAddress}>
                  <TableCell>
                    <Link
                      to={`/index/${holding.basketAddress}`}
                      className="font-mono text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded"
                    >
                      {shortId(holding.basketId)}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div className="flex gap-1">
                      {holding.assetKinds.map((kind) => (
                        <KindBadge key={kind} kind={kind} />
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">{formatShares(holding.sharesOwned)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsd(holding.currentValueUnits)}</TableCell>
                  <TableCell className="text-right">
                    <Pnl units={pnlUnits(holding)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="icon-sm" aria-label="Manage position">
                      <Link to={`/index/${holding.basketAddress}?side=withdraw`}>
                        <ArrowRight aria-hidden />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function IndexesSection() {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const indexes = useQuery({ queryKey: ["indexes"], queryFn: listIndexes });
  const all = indexes.data?.ok ? indexes.data.data : undefined;

  const visible = useMemo(() => {
    if (!all) return [];
    const needle = search.trim().toLowerCase();
    return all
      .filter((index) => filter === "all" || index.assetKinds.includes(filter))
      .filter(
        (index) =>
          needle === "" ||
          index.basketId.toLowerCase().includes(needle) ||
          index.address.toLowerCase().includes(needle),
      );
  }, [all, filter, search]);

  return (
    <section aria-labelledby="indexes-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="indexes-heading" className="text-lg font-semibold tracking-tight">
            All indexes
            {all && <span className="ml-2 text-sm font-normal text-muted-foreground">{all.length}</span>}
          </h2>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
            <TabsList aria-label="Filter by asset class">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="perp">Perps</TabsTrigger>
              <TabsTrigger value="spot">Spot</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative flex-1 sm:w-64 sm:flex-none">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              placeholder="Search by id or address"
              aria-label="Search indexes"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-10 pl-9"
            />
          </div>
        </div>
      </div>

      {indexes.isPending && <IndexGridSkeleton />}

      {indexes.data && !indexes.data.ok && (
        <ErrorState title="Could not load indexes" error={indexes.data.error} onRetry={() => void indexes.refetch()} />
      )}

      {all && all.length === 0 && (
        <EmptyState
          title="No indexes yet"
          description="Compose the first one."
          action={
            <Button asChild>
              <Link to="/create">Create the first index</Link>
            </Button>
          }
        />
      )}

      {all && all.length > 0 && visible.length === 0 && (
        <EmptyState
          title="Nothing matches"
          description="Try another asset class or search."
          action={
            <Button
              variant="outline"
              onClick={() => {
                setFilter("all");
                setSearch("");
              }}
            >
              Clear filters
            </Button>
          }
        />
      )}

      {visible.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((index, order) => (
            <IndexCard key={index.address} index={index} order={order} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function HomePage() {
  return (
    <main className="content-grid flex-1 space-y-10 py-8 sm:py-10">
      <section className="max-w-2xl animate-rise-in">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Index baskets on Solana</h1>
        <p className="mt-2 text-base text-muted-foreground">
          Weighted baskets of Phoenix perps or Solana spot. One deposit buys the whole basket.
        </p>
      </section>

      <PortfolioSection />
      <IndexesSection />

      <Outlet />
    </main>
  );
}
