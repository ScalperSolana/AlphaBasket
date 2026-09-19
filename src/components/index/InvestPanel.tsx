import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Connection, PublicKey } from "@solana/web3.js";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, CircleDashed, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ENV } from "@/env";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { buildFundingTransaction } from "@/lib/funding";
import {
  type ApiResult,
  createDepositQuote,
  createWithdrawalQuote,
  DEFAULT_SLIPPAGE_BPS,
  getOperation,
  submitDepositFunding,
  submitDepositIntent,
  submitWithdrawalIntent,
} from "@/lib/indexApi";
import { depositIntentMessage, nextIntentNonce, toBase64, withdrawalIntentMessage } from "@/lib/intents";
import { cn } from "@/lib/utils";
import {
  formatShares,
  formatUnits,
  formatUsd,
  parseUnits,
  shortAddress,
  UNITS_PER_USD,
  type DepositOperation,
  type DepositQuote,
  type IndexDetail,
  type Operation,
  type PortfolioHolding,
  type WithdrawalQuote,
} from "@/types/index-basket";

export type InvestSide = "deposit" | "withdraw";

/**
 * Where a deposit or withdrawal is.
 *
 * A deposit is: sign the intent → submit it → send one USDC transaction on
 * mainnet → report its signature → wait for execution. A withdrawal skips the
 * two funding steps. Each stage keeps what a retry needs: the same idempotency
 * key resubmits the same intent rather than creating a second operation.
 */
type Flow =
  | { stage: "idle" }
  | { stage: "signing" }
  | { stage: "submitting" }
  | { stage: "funding"; operation: DepositOperation; error?: string }
  | { stage: "sending"; operation: DepositOperation }
  | { stage: "reporting"; operation: DepositOperation; signature: string; error?: string }
  | { stage: "executing"; operation: Operation; signature?: string }
  | { stage: "failed"; message: string; retry?: () => void };

const isUserRejection = (error: unknown): boolean =>
  error instanceof Error && /reject|denied|cancel|declined/iu.test(error.message);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong.";

const PURPOSE_LABEL: Record<string, string> = {
  jupiter_allocation: "Spot allocation",
  polymarket_allocation: "Prediction allocation",
  protocol_deposit_fee: "Deposit fee",
};

function Row({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("tabular-nums", muted && "text-muted-foreground", strong && "font-semibold")}>{value}</dd>
    </div>
  );
}

function Step({ state, label, detail }: { state: "todo" | "active" | "done"; label: string; detail?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
          state === "done" && "bg-success/15 text-success",
          state === "active" && "text-primary",
          state === "todo" && "text-muted-foreground/60",
        )}
        aria-hidden
      >
        {state === "done" ? (
          <Check className="h-3.5 w-3.5" />
        ) : state === "active" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <CircleDashed className="h-4 w-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm", state === "todo" ? "text-muted-foreground" : "font-medium")}>{label}</p>
        {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
      </div>
    </li>
  );
}

export function InvestPanel({
  index,
  holding,
  side,
  onSideChange,
}: {
  index: IndexDetail;
  holding: PortfolioHolding | null;
  side: InvestSide;
  onSideChange: (side: InvestSide) => void;
}) {
  const { publicKey, signMessage, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const queryClient = useQueryClient();
  const user = publicKey?.toBase58() ?? null;

  const perp = index.assetKinds.includes("perp");
  const active = index.status === "active";

  const [amount, setAmount] = useState("");
  const [shares, setShares] = useState("");
  const [flow, setFlow] = useState<Flow>({ stage: "idle" });

  // Switching indexes resets everything; a half-finished deposit into one
  // index must not be shown against another.
  useEffect(() => {
    setFlow({ stage: "idle" });
    setAmount("");
    setShares("");
  }, [index.address]);

  const raw = side === "deposit" ? amount : shares;
  // Debounce side and amount together. Debouncing the amount alone let the
  // deposit amount linger for 400ms after switching to Withdraw, which quoted a
  // withdrawal of "100 shares" that nobody typed.
  const debouncedKey = useDebouncedValue(`${side}:${raw}`, 400);
  const debounced = debouncedKey.startsWith(`${side}:`) ? debouncedKey.slice(side.length + 1) : "";
  const units = useMemo(() => parseUnits(debounced), [debounced]);
  const typedUnits = useMemo(() => parseUnits(raw), [raw]);

  const heldShares = holding ? BigInt(holding.sharesOwned) : 0n;
  const overHeld = side === "withdraw" && typedUnits !== null && typedUnits > heldShares;

  // USDC balance on the capital cluster (mainnet). Absent token account reads as
  // zero; an RPC failure reads as unknown and never blocks the flow.
  const balance = useQuery({
    queryKey: ["usdc-balance", user],
    enabled: user !== null,
    staleTime: 30_000,
    retry: 0,
    queryFn: async (): Promise<bigint | null> => {
      try {
        const connection = new Connection(ENV.CAPITAL_RPC, "confirmed");
        const ata = getAssociatedTokenAddressSync(new PublicKey(ENV.CAPITAL_USDC_MINT), publicKey as PublicKey);
        const result = await connection.getTokenAccountBalance(ata);
        return BigInt(result.value.amount);
      } catch (error) {
        if (error instanceof Error && /could not find|Invalid param/iu.test(error.message)) return 0n;
        return null;
      }
    },
  });
  const overBalance =
    side === "deposit" && typedUnits !== null && balance.data !== null && balance.data !== undefined && typedUnits > balance.data;

  const quoteEnabled = user !== null && units !== null && !perp && active && flow.stage === "idle" && !overHeld;
  const quote = useQuery({
    queryKey: ["quote", side, index.address, user, units?.toString(10)],
    enabled: quoteEnabled,
    staleTime: 20_000,
    gcTime: 0,
    retry: 0,
    placeholderData: keepPreviousData,
    queryFn: (): Promise<ApiResult<DepositQuote | WithdrawalQuote>> =>
      side === "deposit"
        ? createDepositQuote({ basket: index.address, user: user as string, grossAmount: units as bigint })
        : createWithdrawalQuote({ basket: index.address, user: user as string, shareAmount: units as bigint }),
  });
  const quoteData = quoteEnabled && quote.data?.ok ? quote.data.data : undefined;
  const quoteError = quoteEnabled && quote.data && !quote.data.ok ? quote.data.error : undefined;
  const quoting = quoteEnabled && (quote.isFetching || debounced !== raw);

  // Execution progress, polled while an operation is open.
  const operationId = flow.stage === "executing" ? flow.operation.operationId : null;
  const progress = useQuery({
    queryKey: ["operation", operationId],
    enabled: operationId !== null,
    queryFn: () => getOperation(operationId as string),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.ok && (data.data.workState === "completed" || data.data.lastError)) return false;
      return 4_000;
    },
  });
  const liveOperation = progress.data?.ok ? progress.data.data : flow.stage === "executing" ? flow.operation : undefined;
  const completed = liveOperation?.workState === "completed";
  useEffect(() => {
    if (!completed) return;
    void queryClient.invalidateQueries({ queryKey: ["portfolio"] });
    void queryClient.invalidateQueries({ queryKey: ["index", index.address] });
    void queryClient.invalidateQueries({ queryKey: ["indexes"] });
  }, [completed, index.address, queryClient]);

  const reset = () => {
    setFlow({ stage: "idle" });
    void queryClient.invalidateQueries({ queryKey: ["quote"] });
  };

  // --- deposit -------------------------------------------------------------

  const startDeposit = async (signed: DepositQuote) => {
    if (!signMessage) {
      setFlow({ stage: "failed", message: "This wallet cannot sign messages. Phantom, Solflare and Backpack can." });
      return;
    }
    setFlow({ stage: "signing" });
    const nonce = nextIntentNonce();
    let signature: Uint8Array;
    try {
      signature = await signMessage(depositIntentMessage(signed, nonce));
    } catch (error) {
      if (isUserRejection(error)) setFlow({ stage: "idle" });
      else setFlow({ stage: "failed", message: errorMessage(error) });
      return;
    }
    const key = crypto.randomUUID();
    const submit = async () => {
      setFlow({ stage: "submitting" });
      const result = await submitDepositIntent({ quote: signed, nonce, signature: toBase64(signature) }, key);
      if (!result.ok) {
        setFlow({
          stage: "failed",
          message: result.error,
          retry: result.code === "quote_mismatch" || result.status === 400 || result.status === 422 ? undefined : submit,
        });
        return;
      }
      setFlow({ stage: "funding", operation: result.data });
    };
    await submit();
  };

  const sendFunding = async (operation: DepositOperation) => {
    setFlow({ stage: "sending", operation });
    const connection = new Connection(ENV.CAPITAL_RPC, "confirmed");
    let signature: string;
    try {
      const transaction = buildFundingTransaction({
        payer: publicKey as PublicKey,
        mint: new PublicKey(operation.funding.settlementMint),
        transfers: operation.funding.transfers,
      });
      const latest = await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = latest.blockhash;
      transaction.feePayer = publicKey as PublicKey;
      signature = await sendTransaction(transaction, connection);
      await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    } catch (error) {
      if (isUserRejection(error)) setFlow({ stage: "funding", operation });
      else setFlow({ stage: "funding", operation, error: errorMessage(error) });
      return;
    }
    await reportFunding(operation, signature, crypto.randomUUID());
  };

  const reportFunding = async (operation: DepositOperation, signature: string, key: string) => {
    setFlow({ stage: "reporting", operation, signature });
    const result = await submitDepositFunding(operation.operationId, signature, key);
    if (!result.ok) {
      setFlow({ stage: "reporting", operation, signature, error: result.error });
      return;
    }
    setFlow({ stage: "executing", operation: result.data, signature });
  };

  // --- withdrawal -----------------------------------------------------------

  const startWithdrawal = async (signed: WithdrawalQuote) => {
    if (!signMessage) {
      setFlow({ stage: "failed", message: "This wallet cannot sign messages. Phantom, Solflare and Backpack can." });
      return;
    }
    const destination = user as string;
    setFlow({ stage: "signing" });
    const nonce = nextIntentNonce();
    let signature: Uint8Array;
    try {
      signature = await signMessage(withdrawalIntentMessage(signed, nonce, destination));
    } catch (error) {
      if (isUserRejection(error)) setFlow({ stage: "idle" });
      else setFlow({ stage: "failed", message: errorMessage(error) });
      return;
    }
    const key = crypto.randomUUID();
    const submit = async () => {
      setFlow({ stage: "submitting" });
      const result = await submitWithdrawalIntent(
        { quote: signed, nonce, destination, signature: toBase64(signature) },
        key,
      );
      if (!result.ok) {
        setFlow({
          stage: "failed",
          message: result.error,
          retry: result.code === "quote_mismatch" || result.status === 400 || result.status === 422 ? undefined : submit,
        });
        return;
      }
      setFlow({ stage: "executing", operation: result.data });
    };
    await submit();
  };

  // --- render ----------------------------------------------------------------

  const busy = flow.stage !== "idle";

  const depositBreakdown = (q: DepositQuote) => {
    const net = BigInt(q.quotedNetValue);
    const price = BigInt(q.sharePrice);
    const sharesOut = price > 0n ? (net * UNITS_PER_USD) / price : 0n;
    return (
      <dl className="space-y-1.5">
        <Row label="Fee (0.5%)" value={`−${formatUsd(q.protocolFee)}`} muted />
        <Row label="Invested" value={formatUsd(net)} />
        <Row label="You receive" value={`≈ ${formatShares(sharesOut)} shares`} strong />
        <Row label={`Min. after ${DEFAULT_SLIPPAGE_BPS / 100}% slippage`} value={`${formatShares(q.minSharesOut)} shares`} muted />
      </dl>
    );
  };

  const withdrawalBreakdown = (q: WithdrawalQuote) => (
    <dl className="space-y-1.5">
      <Row label="Gross value" value={formatUsd(q.quotedGrossValue)} />
      <Row label="Fee" value={`−${formatUsd(q.quotedProtocolFee)}`} muted />
      {q.quotedCreatorFee !== "0" && <Row label="Creator fee on profit" value={`−${formatUsd(q.quotedCreatorFee)}`} muted />}
      <Row label="You receive at least" value={formatUsd(q.minValueOut)} strong />
    </dl>
  );

  const explorerTx = (signature: string) => (
    <a
      href={`${ENV.EXPLORER_URL}/tx/${signature}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-mono hover:underline"
    >
      {shortAddress(signature, 6)}
      <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );

  return (
    <section className="surface p-5" aria-labelledby="invest-heading">
      <div className="flex items-center justify-between gap-3">
        <h3 id="invest-heading" className="text-sm font-semibold">
          {busy ? (side === "deposit" ? "Deposit in progress" : "Withdrawal in progress") : "Invest"}
        </h3>
        {!busy && (
          <Tabs value={side} onValueChange={(value) => onSideChange(value as InvestSide)}>
            <TabsList className="h-9" aria-label="Deposit or withdraw">
              <TabsTrigger value="deposit" className="px-2.5 text-xs">
                Deposit
              </TabsTrigger>
              <TabsTrigger value="withdraw" className="px-2.5 text-xs">
                Withdraw
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      </div>

      {perp && !busy && (
        <Alert variant="info" className="mt-4">
          <AlertCircle />
          <AlertTitle>Not open yet</AlertTitle>
          <AlertDescription>Perp indexes accept deposits once Phoenix execution is live.</AlertDescription>
        </Alert>
      )}
      {!perp && !active && !busy && (
        <Alert variant="warning" className="mt-4">
          <AlertCircle />
          <AlertTitle>Paused</AlertTitle>
          <AlertDescription>Not accepting deposits or withdrawals right now.</AlertDescription>
        </Alert>
      )}

      {!busy && !perp && active && (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!user) {
              setVisible(true);
              return;
            }
            if (!quoteData) return;
            if (quoteData.kind === "deposit") void startDeposit(quoteData);
            else void startWithdrawal(quoteData);
          }}
        >
          {side === "deposit" ? (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="deposit-amount">Amount</Label>
                {user && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground tabular-nums hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded"
                    onClick={() => balance.data && setAmount(formatUnits(balance.data).replace(/,/g, ""))}
                    disabled={!balance.data}
                  >
                    Balance: {balance.data === undefined ? "…" : balance.data === null ? "—" : `${formatUnits(balance.data)} USDC`}
                  </button>
                )}
              </div>
              <div className="relative">
                <Input
                  id="deposit-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className="pr-16 text-lg font-semibold tabular-nums"
                  aria-invalid={overBalance || undefined}
                  aria-describedby="deposit-hint"
                />
                <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                  USDC
                </span>
              </div>
              {(overBalance || index.sharePriceUnits === null) && (
                <p id="deposit-hint" className={cn("text-xs", overBalance ? "text-destructive" : "text-muted-foreground")}>
                  {overBalance ? "More than your USDC balance." : "First deposit. Shares start at $1.00."}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="withdraw-shares">Shares</Label>
                {user && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground tabular-nums hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded"
                    onClick={() => heldShares > 0n && setShares(formatUnits(heldShares).replace(/,/g, ""))}
                    disabled={heldShares === 0n}
                  >
                    You hold {formatShares(heldShares)}
                  </button>
                )}
              </div>
              <div className="relative">
                <Input
                  id="withdraw-shares"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={shares}
                  onChange={(event) => setShares(event.target.value)}
                  className="pr-20 text-lg font-semibold tabular-nums"
                  aria-invalid={overHeld || undefined}
                  aria-describedby="withdraw-hint"
                />
                <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                  shares
                </span>
              </div>
              <p id="withdraw-hint" className={cn("text-xs", overHeld ? "text-destructive" : "text-muted-foreground")}>
                {overHeld ? `You hold ${formatShares(heldShares)} shares.` : "2% fee before 60 days, 1% after."}
              </p>
            </div>
          )}

          {quoteError && (
            <p role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-foreground">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
              {quoteError}
            </p>
          )}

          {quoteData && !quoteError && (
            <div
              key={quoteData.quoteHash}
              className={cn("animate-rise-in rounded-xl bg-secondary/50 p-3.5 transition-opacity duration-150", quoting && "opacity-60")}
              aria-live="polite"
            >
              {quoteData.kind === "deposit" ? depositBreakdown(quoteData) : withdrawalBreakdown(quoteData)}
            </div>
          )}

          <Button
            type="submit"
            className="w-full"
            size="lg"
            loading={quoting}
            disabled={user !== null && (!quoteData || !!quoteError || overHeld || overBalance || typedUnits === null)}
          >
            {user === null
              ? "Connect wallet"
              : side === "deposit"
                ? typedUnits
                  ? `Deposit ${formatUsd(typedUnits)}`
                  : "Deposit"
                : typedUnits
                  ? `Withdraw ${formatShares(typedUnits)} shares`
                  : "Withdraw"}
          </Button>

        </form>
      )}

      {busy && (
        <div className="mt-4 space-y-4">
          <ol className="space-y-3">
            <Step
              state={flow.stage === "signing" ? "active" : "done"}
              label="Sign the intent"
              detail={flow.stage === "signing" ? "Approve the message in your wallet. It carries this exact quote." : undefined}
            />
            <Step
              state={flow.stage === "signing" ? "todo" : flow.stage === "submitting" || (flow.stage === "failed" && !!flow.retry) ? "active" : "done"}
              label="Submit to AlphaBasket"
            />
            {side === "deposit" && (
              <>
                <Step
                  state={
                    flow.stage === "funding" || flow.stage === "sending"
                      ? "active"
                      : flow.stage === "reporting" || flow.stage === "executing"
                        ? "done"
                        : "todo"
                  }
                  label="Send USDC on Solana mainnet"
                  detail={
                    flow.stage === "funding" || flow.stage === "sending" ? (
                      <div className="space-y-3">
                        <dl className="space-y-1.5 rounded-xl bg-secondary/50 p-3">
                          {flow.operation.funding.transfers.map((transfer) => (
                            <div key={`${transfer.purpose}-${transfer.destination}`} className="flex items-baseline justify-between gap-3">
                              <dt>
                                <span className="text-foreground">{PURPOSE_LABEL[transfer.purpose] ?? transfer.purpose}</span>
                                <span className="ml-1.5 font-mono text-muted-foreground">{shortAddress(transfer.destination)}</span>
                              </dt>
                              <dd className="tabular-nums text-foreground">{formatUsd(transfer.amount)}</dd>
                            </div>
                          ))}
                          <div className="flex items-baseline justify-between gap-3 border-t border-border/60 pt-1.5 font-semibold text-foreground">
                            <dt>Total</dt>
                            <dd className="tabular-nums">
                              {formatUsd(flow.operation.funding.transfers.reduce((sum, t) => sum + BigInt(t.amount), 0n))}
                            </dd>
                          </div>
                        </dl>
                        <p>One transaction. Each transfer is verified before shares are credited.</p>
                        {flow.stage === "funding" && flow.error && (
                          <p role="alert" className="text-destructive">
                            {flow.error}
                          </p>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          className="w-full"
                          loading={flow.stage === "sending"}
                          onClick={() => void sendFunding(flow.operation)}
                        >
                          {flow.stage === "sending" ? "Confirm in wallet" : "Send USDC"}
                        </Button>
                      </div>
                    ) : flow.stage === "reporting" || (flow.stage === "executing" && flow.signature) ? (
                      <span>Sent {explorerTx(flow.signature as string)}</span>
                    ) : undefined
                  }
                />
                <Step
                  state={flow.stage === "reporting" ? "active" : flow.stage === "executing" ? "done" : "todo"}
                  label="Report the transaction"
                  detail={
                    flow.stage === "reporting" && flow.error ? (
                      <div className="space-y-2">
                        <p role="alert" className="text-destructive">
                          {flow.error}
                        </p>
                        <Button type="button" size="sm" variant="outline" onClick={() => void reportFunding(flow.operation, flow.signature, crypto.randomUUID())}>
                          Try again
                        </Button>
                      </div>
                    ) : undefined
                  }
                />
              </>
            )}
            <Step
              state={flow.stage === "executing" ? (completed ? "done" : "active") : "todo"}
              label={side === "deposit" ? "Execute and credit shares" : "Sell pro rata and pay out"}
              detail={
                flow.stage === "executing" ? (
                  liveOperation?.lastError ? (
                    <p role="alert" className="text-destructive">
                      {liveOperation.lastError}
                    </p>
                  ) : completed ? (
                    "Settled."
                  ) : (
                    <span>
                      {liveOperation?.workState === "awaiting_funding"
                        ? "Waiting for the transaction to finalize."
                        : "Executing. Safe to close this panel."}
                      <span className="ml-1 font-mono">#{shortAddress(flow.operation.operationId, 4)}</span>
                    </span>
                  )
                ) : undefined
              }
            />
          </ol>

          {flow.stage === "failed" && (
            <div role="alert" className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3.5">
              <div className="flex items-start gap-2 text-sm">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                <p>{flow.message}</p>
              </div>
              <div className="flex gap-2">
                {flow.retry && (
                  <Button type="button" size="sm" onClick={() => void flow.retry?.()}>
                    Try again
                  </Button>
                )}
                <Button type="button" size="sm" variant="outline" onClick={reset}>
                  Start over
                </Button>
              </div>
            </div>
          )}

          {flow.stage === "executing" && (completed || liveOperation?.lastError) && (
            <Button type="button" variant="outline" className="w-full" onClick={reset}>
              Done
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
