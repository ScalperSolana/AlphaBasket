import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";

import { EmptyState, ErrorState, LoadingState } from "@/components/index/ApiState";
import { IndexCard } from "@/components/index/IndexCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { listIndexes } from "@/lib/indexApi";
import type { IndexAssetKind, IndexSummary } from "@/types/index-basket";

type Filter = "all" | IndexAssetKind;

export default function DiscoverPage() {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; error: string }
    | { status: "ready"; indexes: readonly IndexSummary[] }
  >({ status: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    void listIndexes().then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { status: "ready", indexes: result.data }
          : { status: "error", error: result.error },
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible =
    state.status === "ready"
      ? state.indexes
          .filter((index) => filter === "all" || index.assetKinds.includes(filter))
          .filter(
            (index) =>
              search.trim() === "" ||
              index.basketId.toLowerCase().includes(search.trim().toLowerCase()) ||
              index.address.toLowerCase().includes(search.trim().toLowerCase()),
          )
      : [];

  return (
    <div className="container max-w-6xl py-8 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Indexes</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every index published on chain. Each one is a weighted basket you can
            invest in with a single deposit.
          </p>
        </div>
        <Button asChild>
          <Link to="/create">
            <Plus className="h-4 w-4 mr-1.5" />
            Create index
          </Link>
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="perp">Perps</TabsTrigger>
            <TabsTrigger value="spot">Spot</TabsTrigger>
          </TabsList>
        </Tabs>
        <Input
          placeholder="Search by id or address"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
        />
      </div>

      {state.status === "loading" && <LoadingState label="Loading indexes" />}
      {state.status === "error" && <ErrorState error={state.error} />}

      {state.status === "ready" && visible.length === 0 && (
        <EmptyState
          title={
            state.indexes.length === 0
              ? "No indexes yet"
              : "Nothing matches that filter"
          }
          description={
            state.indexes.length === 0
              ? "Publish the first one. An index is a weighted basket of Phoenix perps or Solana spot tokens."
              : "Try a different asset class or clear the search."
          }
          action={
            state.indexes.length === 0 ? (
              <Button asChild>
                <Link to="/create">Create the first index</Link>
              </Button>
            ) : undefined
          }
        />
      )}

      {state.status === "ready" && visible.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((index) => (
            <IndexCard key={index.address} index={index} />
          ))}
        </div>
      )}
    </div>
  );
}
