import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { INDEX_API_BASE } from "@/lib/indexApi";
import { formatUsd, UNITS_PER_USD, type IndexDetail } from "@/types/index-basket";

type Quote = {
  readonly grossAmount?: string;
  readonly netDepositValue?: string;
  readonly sharesOut?: string;
  readonly protocolFee?: string;
  readonly sharePrice?: string;
  readonly valueOut?: string;
  readonly [key: string]: unknown;
};

const DEFAULT_SLIPPAGE_BPS = 100;

/**
 * Deposit and withdrawal quoting.
 *
 * Stops at the quote deliberately. Submitting the intent requires a signed
 * user message, and signing a value the user has not been shown is exactly the
 * mistake this product cannot make. The quote is the honest half that works
 * today; the signature step is wired once the intent message format is exposed
 * to the browser.
 */
export function InvestPanel({ index }: { index: IndexDetail }) {
  const { publicKey } = useWallet();
  const { toast } = useToast();
  const [amount, setAmount] = useState("100");
  const [shares, setShares] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [pending, setPending] = useState(false);

  const priced = index.sharePriceUnits !== null;

  const requestQuote = async (side: "deposit" | "withdrawal") => {
    if (!publicKey) {
      toast({ title: "Connect a wallet first", variant: "destructive" });
      return;
    }
    const raw = side === "deposit" ? amount : shares;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast({ title: "Enter an amount above zero", variant: "destructive" });
      return;
    }

    setPending(true);
    setQuote(null);
    try {
      const units = BigInt(Math.round(parsed * Number(UNITS_PER_USD))).toString(10);
      const body =
        side === "deposit"
          ? {
              basket: index.address,
              user: publicKey.toBase58(),
              grossAmount: units,
              maxSlippageBps: DEFAULT_SLIPPAGE_BPS,
              expiresAtSeconds: String(Math.floor(Date.now() / 1000) + 300),
            }
          : {
              basket: index.address,
              user: publicKey.toBase58(),
              shareAmount: units,
              maxSlippageBps: DEFAULT_SLIPPAGE_BPS,
              expiresAtSeconds: String(Math.floor(Date.now() / 1000) + 300),
            };

      const response = await fetch(`${INDEX_API_BASE}/v1/quotes/${side}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const payload = (await response.json()) as Quote & { message?: string };
      if (!response.ok) {
        toast({
          title: "Quote refused",
          description: payload.message ?? `HTTP ${response.status}`,
          variant: "destructive",
        });
        return;
      }
      setQuote(payload);
    } catch (error) {
      toast({
        title: "Could not reach the quote API",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="h-fit lg:sticky lg:top-6">
      <CardHeader>
        <CardTitle className="text-base">Invest</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="deposit">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="deposit">Deposit</TabsTrigger>
            <TabsTrigger value="withdraw">Withdraw</TabsTrigger>
          </TabsList>

          <TabsContent value="deposit" className="space-y-3 pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="deposit-amount">Amount (USDC)</Label>
              <Input
                id="deposit-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
            <Button
              className="w-full"
              disabled={pending}
              onClick={() => void requestQuote("deposit")}
            >
              {pending ? "Quoting…" : "Get quote"}
            </Button>
            {!priced && (
              <p className="text-xs text-muted-foreground">
                This index has no priced NAV yet, so the first deposit sets the
                share price at $1.00.
              </p>
            )}
          </TabsContent>

          <TabsContent value="withdraw" className="space-y-3 pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="withdraw-shares">Shares</Label>
              <Input
                id="withdraw-shares"
                inputMode="decimal"
                value={shares}
                onChange={(event) => setShares(event.target.value)}
                placeholder="0.00"
              />
            </div>
            <Button
              className="w-full"
              variant="secondary"
              disabled={pending}
              onClick={() => void requestQuote("withdrawal")}
            >
              {pending ? "Quoting…" : "Get quote"}
            </Button>
          </TabsContent>
        </Tabs>

        {quote && (
          <>
            <Separator className="my-4" />
            <dl className="space-y-2 text-sm">
              {[
                ["Gross", quote.grossAmount],
                ["Net value", quote.netDepositValue],
                ["Protocol fee", quote.protocolFee],
                ["Value out", quote.valueOut],
                ["Share price", quote.sharePrice],
              ]
                .filter(([, value]) => typeof value === "string")
                .map(([label, value]) => (
                  <div key={label as string} className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="tabular-nums font-medium">
                      {formatUsd(value as string)}
                    </dd>
                  </div>
                ))}
              {typeof quote.sharesOut === "string" && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Shares out</dt>
                  <dd className="tabular-nums font-medium">
                    {Number(quote.sharesOut).toLocaleString()}
                  </dd>
                </div>
              )}
            </dl>
            <p className="text-xs text-muted-foreground mt-4">
              Signing and submitting the intent is the next step. It is not wired
              yet, so nothing has been sent.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
