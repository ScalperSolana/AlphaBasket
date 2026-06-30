import {
  AnchorProvider,
  Program,
  BN,
  type Idl,
  type Wallet,
} from '@coral-xyz/anchor';
import type { AnchorWallet } from '@solana/wallet-adapter-react';
import {
  Connection,
  PublicKey,
  Ed25519Program,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { connection, USDC_MINT } from '@/lib/solana/connection';
import idlJson from '@/lib/solana/idl/polybaskets_escrow.json';
import type { PolybasketsEscrow } from '@/lib/solana/idl/polybaskets_escrow';
import type { SignedQuote } from '@/lib/solana/quoteApi';

export const ESCROW_PROGRAM_ID = new PublicKey((idlJson as { address: string }).address);

/** sha256(off-chain string id) → 32-byte on-chain basket id. */
export async function basketIdBytes(stringId: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(stringId);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

// ---- PDA derivations ----
export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], ESCROW_PROGRAM_ID)[0];
}
export function basketPda(idBytes: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('basket'), Buffer.from(idBytes)], ESCROW_PROGRAM_ID)[0];
}
export function vaultPda(idBytes: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), Buffer.from(idBytes)], ESCROW_PROGRAM_ID)[0];
}
export function positionPda(idBytes: Uint8Array, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('position'), Buffer.from(idBytes), owner.toBuffer()],
    ESCROW_PROGRAM_ID,
  )[0];
}

/** Build a read-only Program (no signing) for fetching accounts. */
export function readonlyProgram(): Program<PolybasketsEscrow> {
  const provider = new AnchorProvider(
    connection,
    // dummy wallet — only used for reads
    { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t } as unknown as Wallet,
    { commitment: 'confirmed' },
  );
  return new Program(idlJson as Idl, provider) as unknown as Program<PolybasketsEscrow>;
}

/** Build a signing Program from a wallet-adapter wallet. */
export function escrowProgram(wallet: AnchorWallet, conn: Connection = connection): Program<PolybasketsEscrow> {
  const provider = new AnchorProvider(conn, wallet as unknown as Wallet, { commitment: 'confirmed' });
  return new Program(idlJson as Idl, provider) as unknown as Program<PolybasketsEscrow>;
}

/** Whether a basket already exists on-chain. */
export async function basketExists(idBytes: Uint8Array): Promise<boolean> {
  const info = await connection.getAccountInfo(basketPda(idBytes));
  return info !== null;
}

/** Read the on-chain basket account (settlement status/index), or null. */
export async function fetchBasket(idBytes: Uint8Array): Promise<{
  /** True only once finalize_settlement has run (claims allowed). */
  settled: boolean;
  /** True while a settlement is proposed but the challenge window is still open. */
  proposed: boolean;
  settlementIndexBps: number;
  /** Index pending finalization while `proposed` (0 otherwise). */
  proposedIndexBps: number;
  /** Unix time of the proposal (0 if none). */
  settlementProposedAt: number;
  totalStaked: bigint;
} | null> {
  const program = readonlyProgram();
  try {
    const acct = await program.account.basket.fetch(basketPda(idBytes));
    const status = acct.status as { settled?: unknown; proposed?: unknown };
    return {
      settled: status.settled !== undefined,
      proposed: status.proposed !== undefined,
      settlementIndexBps: Number(acct.settlementIndexBps),
      proposedIndexBps: Number(acct.proposedIndexBps),
      settlementProposedAt: Number(acct.settlementProposedAt),
      totalStaked: BigInt(acct.totalStaked.toString()),
    };
  } catch {
    return null;
  }
}

/** Read a wallet's on-chain position for a basket, or null. */
export async function fetchPosition(idBytes: Uint8Array, owner: PublicKey): Promise<{
  stakeUnits: bigint;
  entryIndexBps: number;
  claimed: boolean;
  lastNonce: bigint;
} | null> {
  const program = readonlyProgram();
  try {
    const acct = await program.account.position.fetch(positionPda(idBytes, owner));
    return {
      stakeUnits: BigInt(acct.stakeAmount.toString()),
      entryIndexBps: Number(acct.entryIndexBps),
      claimed: acct.claimed,
      lastNonce: BigInt(acct.lastQuoteNonce.toString()),
    };
  } catch {
    return null;
  }
}

/** Basket composition stored on-chain: Polymarket market + outcome + weight. */
export interface OnChainBasketItemInput {
  marketId: string;
  outcome: 'YES' | 'NO';
  weightBps: number;
}

/**
 * Map frontend items to the on-chain shape and force the weights to sum to
 * exactly 10000 bps (the program requires it). Any rounding remainder is applied
 * to the largest-weight item.
 */
function toOnChainItems(
  items: OnChainBasketItemInput[],
): Array<{ marketId: string; outcome: number; weightBps: number }> {
  const mapped = items.map((it) => ({
    marketId: it.marketId,
    outcome: it.outcome === 'YES' ? 1 : 0,
    weightBps: Math.max(1, Math.round(it.weightBps)),
  }));
  const total = mapped.reduce((sum, it) => sum + it.weightBps, 0);
  const diff = 10000 - total;
  if (diff !== 0 && mapped.length > 0) {
    let maxIdx = 0;
    mapped.forEach((it, i) => {
      if (it.weightBps > mapped[maxIdx].weightBps) maxIdx = i;
    });
    mapped[maxIdx].weightBps = Math.max(1, mapped[maxIdx].weightBps + diff);
  }
  return mapped;
}

/** Create the basket + vault on-chain (with its composition) if it doesn't exist. */
export async function ensureBasket(
  wallet: AnchorWallet,
  idBytes: Uint8Array,
  items: OnChainBasketItemInput[],
): Promise<void> {
  if (await basketExists(idBytes)) {
    return;
  }
  const program = escrowProgram(wallet);
  await program.methods
    .createBasket(Array.from(idBytes), toOnChainItems(items))
    .accounts({
      config: configPda(),
      basket: basketPda(idBytes),
      vault: vaultPda(idBytes),
      usdcMint: USDC_MINT,
      creator: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/**
 * Stake USDC into a basket using a backend-signed entry-index quote.
 * Sends the Ed25519 verify instruction + the stake instruction in one tx.
 */
export async function stakeWithQuote(
  wallet: AnchorWallet,
  idBytes: Uint8Array,
  amountUnits: bigint,
  quote: SignedQuote,
): Promise<string> {
  const program = escrowProgram(wallet);
  const owner = wallet.publicKey;
  const stakerUsdc = getAssociatedTokenAddressSync(USDC_MINT, owner);

  const edIx = Ed25519Program.createInstructionWithPublicKey({
    publicKey: new PublicKey(quote.signerPubkey).toBytes(),
    message: Buffer.from(quote.message, 'base64'),
    signature: Buffer.from(quote.signature, 'base64'),
  });

  return program.methods
    .stake(new BN(amountUnits.toString()), quote.entryIndexBps, new BN(quote.nonce.toString()), new BN(quote.expiry.toString()))
    .accounts({
      config: configPda(),
      basket: basketPda(idBytes),
      vault: vaultPda(idBytes),
      position: positionPda(idBytes, owner),
      stakerUsdc,
      usdcMint: USDC_MINT,
      staker: owner,
      ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([edIx])
    .rpc();
}

/** Claim a settled position; the program pays out by formula. */
export async function claimPosition(wallet: AnchorWallet, idBytes: Uint8Array): Promise<string> {
  const program = escrowProgram(wallet);
  const owner = wallet.publicKey;
  const claimerUsdc = getAssociatedTokenAddressSync(USDC_MINT, owner);
  return program.methods
    .claim()
    .accounts({
      config: configPda(),
      basket: basketPda(idBytes),
      vault: vaultPda(idBytes),
      position: positionPda(idBytes, owner),
      claimerUsdc,
      usdcMint: USDC_MINT,
      claimer: owner,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

export { Transaction };
