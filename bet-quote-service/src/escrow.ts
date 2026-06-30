import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const idlPath = fileURLToPath(new URL('./idl/polybaskets_escrow.json', import.meta.url));
const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as anchor.Idl & { address: string };

const connection = new Connection(config.rpcUrl, 'confirmed');
// Read-only: a throwaway wallet is fine, we only fetch accounts.
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(Keypair.generate()), {
  commitment: 'confirmed',
});
const program = new anchor.Program(idl, provider);
const programId = new PublicKey(idl.address);

export interface ChainBasketItem {
  marketId: string;
  outcome: 'YES' | 'NO';
  weightBps: number;
}

const basketPda = (idBytes: Buffer): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('basket'), idBytes], programId)[0];

/** Read a basket's composition from the program, or null if it doesn't exist. */
export async function getBasketItems(idBytes: Buffer): Promise<ChainBasketItem[] | null> {
  try {
    const acct = await (program.account as Record<string, { fetch: (pk: PublicKey) => Promise<any> }>)
      .basket.fetch(basketPda(idBytes));
    return (acct.items as Array<{ marketId: string; outcome: number; weightBps: number }>).map((it) => ({
      marketId: it.marketId,
      outcome: it.outcome === 1 ? 'YES' : 'NO',
      weightBps: Number(it.weightBps),
    }));
  } catch {
    return null;
  }
}
