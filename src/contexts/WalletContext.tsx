import React, { ReactNode, createContext, useContext, useMemo } from 'react';
import { useWallet as useSolanaWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';

interface WalletContextType {
  /** Connected wallet address as a base58 string, or null. */
  address: string | null;
  isConnecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

/**
 * Thin wrapper over the Solana Wallet Adapter that preserves the original
 * { address, isConnecting, connect, disconnect } interface so existing
 * consumers keep working on top of the Solana wallet adapter.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const { publicKey, connecting, disconnect: solanaDisconnect } = useSolanaWallet();
  const { setVisible } = useWalletModal();

  const value = useMemo<WalletContextType>(
    () => ({
      address: publicKey ? publicKey.toBase58() : null,
      isConnecting: connecting,
      // Open the wallet picker (Phantom / Solflare / Backpack).
      connect: async () => {
        setVisible(true);
      },
      disconnect: () => {
        void solanaDisconnect();
      },
    }),
    [publicKey, connecting, setVisible, solanaDisconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}
