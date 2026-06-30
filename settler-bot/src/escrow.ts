import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

/** Load the deployed program IDL (also exported into dist/ by the build script). */
const idlPath = fileURLToPath(new URL('./idl/polybaskets_escrow.json', import.meta.url));
const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as anchor.Idl & {
  address: string;
  constants?: Array<{ name: string; value: string }>;
};

const connection = new Connection(config.rpcUrl, 'confirmed');
const keypair = Keypair.fromSecretKey(bs58.decode(config.settlerKeypairBase58));
const wallet = new anchor.Wallet(keypair);
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
const program = new anchor.Program(idl, provider);
const programId = new PublicKey(idl.address);

/** The settler keypair must equal the program's configured oracle_authority. */
export const oracleAuthority = keypair.publicKey;

/** Challenge window (seconds), read from the program's IDL constant. */
export const CHALLENGE_WINDOW_SECS = Number(
  (idl.constants ?? []).find((c) => c.name === 'CHALLENGE_WINDOW_SECS')?.value ?? 12,
);

const configPda = (): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0];

export type BasketStatus = 'Active' | 'Proposed' | 'Settled';

export interface BasketItem {
  marketId: string;
  outcome: 'YES' | 'NO';
  weightBps: number;
}

export interface OnChainBasket {
  pubkey: PublicKey;
  /** Short label for logs. */
  label: string;
  status: BasketStatus;
  settlementProposedAt: number;
  items: BasketItem[];
}

/**
 * Enumerate every basket on-chain (getProgramAccounts via the account
 * discriminator) and read its composition. Replaces the off-chain registry — the
 * program now stores markets + weights in each Basket account.
 */
export async function getAllBaskets(): Promise<OnChainBasket[]> {
  const all = await (program.account as Record<string, { all: () => Promise<any[]> }>).basket.all();
  return all.map((entry) => {
    const account = entry.account as {
      status: Record<string, unknown>;
      settlementProposedAt: anchor.BN;
      items: Array<{ marketId: string; outcome: number; weightBps: number }>;
    };
    const statusKey = Object.keys(account.status)[0];
    const status = (statusKey.charAt(0).toUpperCase() + statusKey.slice(1)) as BasketStatus;
    const items: BasketItem[] = account.items.map((it) => ({
      marketId: it.marketId,
      outcome: it.outcome === 1 ? 'YES' : 'NO',
      weightBps: Number(it.weightBps),
    }));
    return {
      pubkey: entry.publicKey as PublicKey,
      label: (entry.publicKey as PublicKey).toBase58().slice(0, 8),
      status,
      settlementProposedAt: Number(account.settlementProposedAt),
      items,
    };
  });
}

/** Oracle-only: propose the settlement index, opening the challenge window. */
export async function proposeSettlement(basket: PublicKey, settlementIndexBps: number): Promise<string> {
  return program.methods
    .proposeSettlement(settlementIndexBps)
    .accounts({ config: configPda(), basket, oracleAuthority })
    .rpc();
}

/** Oracle-only: finalize once the challenge window has elapsed. */
export async function finalizeSettlement(basket: PublicKey): Promise<string> {
  return program.methods
    .finalizeSettlement()
    .accounts({ config: configPda(), basket, oracleAuthority })
    .rpc();
}
