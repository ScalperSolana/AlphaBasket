import { useWallet } from '@/contexts/WalletContext';
import { Button } from '@/components/ui/button';
import { Wallet as WalletIcon } from 'lucide-react';

export function WalletButton() {
  const { address, isConnecting, connect, disconnect } = useWallet();
  const buttonClassName = 'wallet-button-primary whitespace-nowrap gap-2';

  if (address) {
    return (
      <Button className={buttonClassName} onClick={disconnect}>
        <WalletIcon className="w-4 h-4" />
        {address.slice(0, 4)}...{address.slice(-4)}
      </Button>
    );
  }

  return (
    <Button className={buttonClassName} onClick={connect} disabled={isConnecting}>
      <WalletIcon className="w-4 h-4" />
      {isConnecting ? 'Connecting...' : 'Connect Wallet'}
    </Button>
  );
}
