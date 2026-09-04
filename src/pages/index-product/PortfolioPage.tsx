import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";

import { EmptyState, ErrorState, LoadingState } from "@/components/index/ApiState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getPortfolio } from "@/lib/indexApi";
import {
  ASSET_KIND_LABEL,
  formatUsd,
  shortId,
  type PortfolioHolding,
} from "@/types/index-basket";

/** Signed difference between current value and cost basis, in six-decimal units. */
const pnlUnits = (holding: PortfolioHolding): bigint | null => {
  if (holding.currentValueUnits === null) return null;
  try {
    return BigInt(holding.currentValueUnits) - BigInt(holding.costBasisValue);
  } catch {
    return null;
  }
};

export default function PortfolioPage() {
  const { publicKey } = useWallet();
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; error: string }
    | { status: "ready"; holdings: readonly PortfolioHolding[] }
  >({ status: "idle" });

  useEffect(() => {
    if (!publicKey) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void getPortfolio(publicKey.toBase58()).then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { status: "ready", holdings: result.data }
          : { status: "error", error: result.error },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  const totalValue =
    state.status === "ready"
      ? state.holdings.reduce(
          (sum, holding) =>
            sum + BigInt(holding.currentValueUnits ?? holding.costBasisValue),
          0n,
        )
      : 0n;

  return (
    <div className="container max-w-5xl py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every index you hold shares in, valued at the latest NAV snapshot.
        </p>
      </header>

      {state.status === "idle" && (
        <EmptyState
          title="Connect a wallet"
          description="Your positions are keyed to your wallet address. Connect one to see them."
        />
      )}
      {state.status === "loading" && <LoadingState label="Loading portfolio" />}
      {state.status === "error" && <ErrorState error={state.error} />}

      {state.status === "ready" && state.holdings.length === 0 && (
        <EmptyState
          title="Nothing here yet"
          description="You do not hold shares in any index. Browse what has been published and make a first deposit."
          action={
            <Button asChild>
              <Link to="/">Browse indexes</Link>
            </Button>
          }
        />
      )}

      {state.status === "ready" && state.holdings.length > 0 && (
        <>
          <Card>
            <CardContent className="pt-6">
              <p className="text-xs text-muted-foreground">Total value</p>
              <p className="text-3xl font-semibold tabular-nums mt-1">
                {formatUsd(totalValue.toString(10))}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                across {state.holdings.length}{" "}
                {state.holdings.length === 1 ? "index" : "indexes"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Index</TableHead>
                    <TableHead>Holds</TableHead>
                    <TableHead className="text-right">Shares</TableHead>
                    <TableHead className="text-right">Cost basis</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">P&amp;L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.holdings.map((holding) => {
                    const pnl = pnlUnits(holding);
                    return (
                      <TableRow key={holding.basketAddress}>
                        <TableCell>
                          <Link
                            to={`/index/${holding.basketAddress}`}
                            className="font-mono text-sm hover:underline"
                          >
                            {shortId(holding.basketId)}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {holding.assetKinds.map((kind) => (
                              <Badge key={kind} variant="outline" className="text-xs">
                                {ASSET_KIND_LABEL[kind]}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {Number(holding.sharesOwned).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatUsd(holding.costBasisValue)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatUsd(holding.currentValueUnits)}
                        </TableCell>
                        <TableCell
                          className={`text-right tabular-nums ${
                            pnl === null
                              ? "text-muted-foreground"
                              : pnl >= 0n
                                ? "text-emerald-500"
                                : "text-red-500"
                          }`}
                        >
                          {pnl === null
                            ? "—"
                            : `${pnl >= 0n ? "+" : "-"}${formatUsd(
                                (pnl < 0n ? -pnl : pnl).toString(10),
                              )}`}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
