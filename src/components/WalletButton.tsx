import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Check, ChevronDown, Copy, ExternalLink, LogOut, Wallet as WalletIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ENV } from "@/env";
import { useCopy } from "@/hooks/useCopy";
import { shortAddress } from "@/types/index-basket";

/**
 * Three states, not two: disconnected, connecting, connected. Connected opens a
 * small menu rather than disconnecting on click, which is what a single
 * "click the address" button used to do and is far too easy to hit by accident.
 */
export function WalletButton() {
  const { publicKey, connecting, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  const { copied, copy } = useCopy();

  if (connecting) {
    return (
      <Button variant="secondary" loading>
        Connecting
      </Button>
    );
  }

  if (!publicKey) {
    return (
      <Button onClick={() => setVisible(true)}>
        <WalletIcon aria-hidden />
        Connect wallet
      </Button>
    );
  }

  const address = publicKey.toBase58();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" className="gap-2 pl-3 pr-2.5" aria-label={`Wallet ${address}`}>
          <span className="h-2 w-2 rounded-full bg-success" aria-hidden />
          <span className="font-mono text-xs tabular-nums">{shortAddress(address)}</span>
          <ChevronDown className="!size-3.5 text-muted-foreground max-sm:hidden" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2.5 pb-2 pt-1.5">
          <p className="text-xs text-muted-foreground">{wallet?.adapter.name ?? "Wallet"}</p>
          <p className="truncate font-mono text-xs">{address}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={(event) => { event.preventDefault(); void copy(address); }}>
          {copied ? <Check className="!text-success" aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy address"}
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={`${ENV.EXPLORER_URL}/account/${address}`} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden />
            View on explorer
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void disconnect()}>
          <LogOut aria-hidden />
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
