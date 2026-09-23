import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Loaded with an empty prefix so non-VITE_ variables are visible here. Only
  // `VITE_`-prefixed values are ever inlined into client code, so a provider
  // key read here stays on the dev server.
  const env = loadEnv(mode, process.cwd(), "");

  /**
   * Mainnet RPC proxy.
   *
   * The deposit flow needs a mainnet RPC from the browser, and keyed providers
   * put the credential in the URL. Putting that URL in `VITE_CAPITAL_SOLANA_RPC_URL`
   * would bake the key into the bundle every visitor downloads, so the browser
   * talks to `/rpc` on the dev server instead and the key is attached here.
   * Production needs the same shape from a real reverse proxy (or a
   * domain-restricted key); see `.env.example`.
   */
  const capitalRpc = env.SOLANA_CAPITAL_RPC_URL?.trim();
  const rpcProxy = (() => {
    if (!capitalRpc) return {};
    const url = new URL(capitalRpc);
    return {
      "/rpc": {
        target: url.origin,
        changeOrigin: true,
        ws: true,
        rewrite: () => `${url.pathname}${url.search}`,
      },
    };
  })();

  return {
  server: {
    host: "::",
    port: 8080,
    proxy: {
      ...rpcProxy,
      "/gamma": {
        target: "https://gamma-api.polymarket.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gamma/, ""),
      },
      "/indexer-graphql": {
        target: "https://indexer-api-production-08f9.up.railway.app",
        changeOrigin: true,
        rewrite: () => "/graphql",
      },
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      buffer: "buffer",
    },
  },
  optimizeDeps: {
    include: ["buffer"],
  },
  define: {
    global: 'globalThis',
  },
  // Remove console.log and console.warn (keeps console.error for real errors)
  esbuild: {
    pure: ['console.log', 'console.warn', 'console.info', 'console.debug'],
  },
  };
});
