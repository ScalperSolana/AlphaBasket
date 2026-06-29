import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Routes, Route, useLocation } from "react-router-dom";
import { NetworkProvider } from "@/contexts/NetworkContext";
import { WalletProvider } from "@/contexts/WalletContext";
import { BasketProvider } from "@/contexts/BasketContext";
import { Header } from "@/components/layout/Header";
import Index from "./pages/Index";
import ExplorePage from "./pages/ExplorePage";
import ExplorerHoldPage from "./pages/ExplorerHoldPage";
import BuilderPage from "./pages/BuilderPage";
import BasketPage from "./pages/BasketPage";
import MyBasketsPage from "./pages/MyBasketsPage";
// import DocsPage from "./pages/DocsPage"; // Hidden for now
import NotFound from "./pages/NotFound";
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { ENV } from "./env";
import { ReactNode, useEffect, useMemo } from "react";
import { Send } from "lucide-react";

const queryClient = new QueryClient();

function AppRoutes() {
  const hostname = window.location.hostname;
  const isAppHost = hostname === "app.polybaskets.xyz";
  const isExplorerHoldEnabled = ENV.EXPLORER_HOLD_ENABLED;
  const holdPage = <ExplorerHoldPage />;
  const explorerEntryPage = isExplorerHoldEnabled ? holdPage : <ExplorePage />;
  const builderEntryPage = isExplorerHoldEnabled ? holdPage : <BuilderPage />;
  const basketsEntryPage = isExplorerHoldEnabled ? holdPage : <MyBasketsPage />;

  return (
    <Routes>
      <Route
        path="/"
        element={isAppHost ? <Navigate to="/explorer" replace /> : <Index />}
      />
      <Route path="/explorer" element={explorerEntryPage} />
      <Route path="/builder" element={builderEntryPage} />
      <Route path="/claim" element={<Navigate to="/explorer" replace />} />
      <Route path="/basket/:id" element={<BasketPage />} />
      <Route path="/me" element={basketsEntryPage} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function ReferralCapture() {
  const location = useLocation();

  useEffect(() => {
    const ref = new URLSearchParams(location.search).get("ref");
    if (ref) {
      window.localStorage.setItem("polybaskets.pendingReferrer", ref);
    }
  }, [location.search]);

  return null;
}

function TelegramUpdatesCta() {
  return (
    <a
      href="https://t.me/polybaskets"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Join PolyBaskets on Telegram"
      className="fixed bottom-20 right-4 md:bottom-4 z-40 inline-flex items-center gap-2 rounded-full border border-primary/40 bg-background/90 px-4 py-2 text-sm font-medium text-primary shadow-[0_0_24px_rgba(132,255,0,0.12)] backdrop-blur-md transition-all duration-200 hover:border-primary/70 hover:bg-background hover:text-primary hover:shadow-[0_0_28px_rgba(132,255,0,0.2)]"
    >
      <Send className="h-4 w-4" />
      <span>Get Updates</span>
    </a>
  );
}

function RoutedLayout() {
  const location = useLocation();

  if (location.pathname === "/") {
    return (
      <>
        <ReferralCapture />
        <AppRoutes />
        <TelegramUpdatesCta />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-background bg-pattern scanlines relative">
      <div className="fixed inset-0 pointer-events-none -z-10" />
      <Header />
      <ReferralCapture />
      <AppRoutes />
      <TelegramUpdatesCta />
    </div>
  );
}

// Solana wallet + connection providers
function SolanaProviders({ children }: { children: ReactNode }) {
  // Phantom, Solflare, Backpack, MetaMask (Solana) and other Wallet Standard
  // wallets register themselves and are auto-detected — so the modal lists only
  // wallets the user actually has installed. Passing explicit legacy adapters
  // made non-installed wallets appear and throw "compatible wallet not found".
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={ENV.SOLANA_RPC}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}

// Inner app component
function AppInner() {
  return (
    <SolanaProviders>
      <WalletProvider>
        <BasketProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <RoutedLayout />
            </BrowserRouter>
          </TooltipProvider>
        </BasketProvider>
      </WalletProvider>
    </SolanaProviders>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <NetworkProvider>
      <AppInner />
    </NetworkProvider>
  </QueryClientProvider>
);

export default App;
