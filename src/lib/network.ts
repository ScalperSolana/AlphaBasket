import { NetworkConfig, NetworkType } from '@/types/basket.ts';
import { ENV } from '@/env';

export const NETWORKS: Record<NetworkType, NetworkConfig> = {
  solana: {
    id: 'solana',
    name: 'Solana',
    cluster: ENV.SOLANA_CLUSTER,
    rpcUrl: ENV.SOLANA_RPC,
    treasury: ENV.TREASURY_ADDRESS,
    explorerBase: 'https://explorer.solana.com',
  },
};

export function getNetworkConfig(network: NetworkType): NetworkConfig {
  return NETWORKS[network];
}

function clusterSuffix(network: NetworkType): string {
  const { cluster } = NETWORKS[network];
  return cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
}

export function getExplorerUrl(network: NetworkType, txSignature: string): string {
  const config = NETWORKS[network];
  return `${config.explorerBase}/tx/${txSignature}${clusterSuffix(network)}`;
}

export function getAddressExplorerUrl(network: NetworkType, address: string): string {
  const config = NETWORKS[network];
  return `${config.explorerBase}/address/${address}${clusterSuffix(network)}`;
}
