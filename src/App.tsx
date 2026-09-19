import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { CreatePanel } from "@/components/index/CreatePanel";
import { IndexPanel } from "@/components/index/IndexPanel";
import { Header } from "@/components/layout/Header";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ENV } from "./env";
import HomePage from "./pages/HomePage";
import NotFound from "./pages/NotFound";

// The prediction-market contest surface (pages/Index, ExplorePage,
// ExplorerHoldPage, BuilderPage, BasketPage, MyBasketsPage, LandingPage,
// DocsPage) stays on disk and off the router. Nothing there is reachable.

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * One page. Everything opens in place:
 *
 *   /                 indexes and, once a wallet is connected, your positions
 *   /index/:address   an index's composition, valuation and deposit/withdraw,
 *                     as a panel over the list
 *   /create           the index builder, as a panel over the list
 *
 * The two panel routes are nested so the list stays mounted underneath and a
 * deep link lands with the panel already open.
 */
function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />}>
        <Route path="index/:address" element={<IndexPanel />} />
        <Route path="create" element={<CreatePanel />} />
      </Route>

      {/* Old paths, so a stale link lands somewhere sensible. */}
      <Route path="/explorer" element={<Navigate to="/" replace />} />
      <Route path="/builder" element={<Navigate to="/create" replace />} />
      <Route path="/me" element={<Navigate to="/" replace />} />
      <Route path="/portfolio" element={<Navigate to="/" replace />} />

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function SolanaProviders({ children }: { children: React.ReactNode }) {
  // Wallet Standard wallets (Phantom, Solflare, Backpack, …) register
  // themselves, so the picker lists only wallets the user actually has.
  // Passing explicit legacy adapters made absent wallets appear and throw.
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={ENV.SOLANA_RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SolanaProviders>
        <TooltipProvider delayDuration={200}>
          <BrowserRouter>
            <div className="flex min-h-screen flex-col">
              <Header />
              <AppRoutes />
            </div>
          </BrowserRouter>
          <Toaster />
        </TooltipProvider>
      </SolanaProviders>
    </QueryClientProvider>
  );
}
