import * as anchor from '@coral-xyz/anchor';
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, requireOperatorSecret } from './config.js';
import { fetchMarketById } from './polymarket.js';
import { validateCanonicalBasket, type CanonicalBasket } from './schema.js';

const idlPath = fileURLToPath(new URL('../../src/lib/solana/idl/polybaskets_escrow.json', import.meta.url));
const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as anchor.Idl & { address: string };
const programId = new PublicKey(idl.address);
const connection = new Connection(config.rpcUrl, 'confirmed');
const usdcMint = new PublicKey(config.usdcMint);

type Program = anchor.Program<anchor.Idl>;

function decodeKeypair(value: string): Keypair {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    const bytes = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

function readonlyWallet(): anchor.Wallet {
  const keypair = Keypair.generate();
  return new anchor.Wallet(keypair);
}

function programFor(wallet: anchor.Wallet): Program {
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  return new anchor.Program(idl, provider);
}

function readonlyProgram(): Program {
  return programFor(readonlyWallet());
}

function operatorContext(): { keypair: Keypair; wallet: anchor.Wallet; program: Program } {
  const keypair = decodeKeypair(requireOperatorSecret());
  const wallet = new anchor.Wallet(keypair);
  return { keypair, wallet, program: programFor(wallet) };
}

export function basketIdBytes(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0];
}

export function basketPda(idBytes: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('basket'), Buffer.from(idBytes)], programId)[0];
}

export function vaultPda(idBytes: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), Buffer.from(idBytes)], programId)[0];
}

export function positionPda(idBytes: Uint8Array, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('position'), Buffer.from(idBytes), owner.toBuffer()],
    programId,
  )[0];
}

async function verifyMarkets(basket: CanonicalBasket): Promise<void> {
  await Promise.all(basket.markets.map(async (item) => {
    const market = await fetchMarketById(item.marketId);
    if (!market || !market.acceptingOrders) {
      throw new Error(`Polymarket market ${item.marketId} is missing, closed, or not accepting orders`);
    }
  }));
}

function onchainItems(basket: CanonicalBasket): Array<{ marketId: string; outcome: number; weightBps: number }> {
  return basket.markets.map((market) => ({
    marketId: market.marketId,
    outcome: market.outcome === 'YES' ? 1 : 0,
    weightBps: market.weightBps,
  }));
}

export async function createBasketOnchain(input: unknown): Promise<{
  basketId: string;
  basketIdHex: string;
  basketPda: string;
  vaultPda: string;
  signature: string;
  alreadyExisted: boolean;
}> {
  const basket = validateCanonicalBasket(input);
  await verifyMarkets(basket);
  const basketId = basket.basketId ?? randomUUID();
  const idBytes = basketIdBytes(basketId);
  const basketAddress = basketPda(idBytes);
  const existing = await connection.getAccountInfo(basketAddress);
  if (existing) {
    return {
      basketId,
      basketIdHex: idBytes.toString('hex'),
      basketPda: basketAddress.toBase58(),
      vaultPda: vaultPda(idBytes).toBase58(),
      signature: '',
      alreadyExisted: true,
    };
  }

  const { keypair, program } = operatorContext();
  const signature = await (program.methods as any)
    .createBasket([...idBytes], onchainItems(basket))
    .accounts({
      config: configPda(),
      basket: basketAddress,
      vault: vaultPda(idBytes),
      usdcMint,
      creator: keypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return {
    basketId,
    basketIdHex: idBytes.toString('hex'),
    basketPda: basketAddress.toBase58(),
    vaultPda: vaultPda(idBytes).toBase58(),
    signature,
    alreadyExisted: false,
  };
}

type SignedQuote = {
  entryIndexBps: number;
  nonce: number;
  expiry: number;
  signerPubkey: string;
  message: string;
  signature: string;
};

async function signedQuote(idBytes: Buffer, owner: PublicKey): Promise<SignedQuote> {
  const response = await fetch(`${config.quoteApiUrl}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ basketId: idBytes.toString('hex'), owner: owner.toBase58() }),
    signal: AbortSignal.timeout(12_000),
  });
  const payload = await response.json() as SignedQuote & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Quote service returned ${response.status}`);
  return payload;
}

function usdcUnits(value: string | number): bigint {
  const input = String(value).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(input)) throw new Error('amountUsdc must be positive with at most 6 decimals');
  const [whole = '0', fraction = ''] = input.split('.');
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (units <= 0n) throw new Error('amountUsdc must be greater than zero');
  return units;
}

async function stakeBuilder(
  program: Program,
  basketId: string,
  owner: PublicKey,
  amountUsdc: string | number,
): Promise<{ idBytes: Buffer; quote: SignedQuote; builder: any; ownerUsdc: PublicKey }> {
  const idBytes = basketIdBytes(basketId);
  if (!(await connection.getAccountInfo(basketPda(idBytes)))) throw new Error('Basket does not exist on-chain');
  const amountUnits = usdcUnits(amountUsdc);
  if (amountUnits > 500_000_000n) {
    throw new Error('A wallet may deposit at most 500 USDC into one basket');
  }
  const quote = await signedQuote(idBytes, owner);
  const ownerUsdc = getAssociatedTokenAddressSync(usdcMint, owner);
  const ed25519 = Ed25519Program.createInstructionWithPublicKey({
    publicKey: new PublicKey(quote.signerPubkey).toBytes(),
    message: Buffer.from(quote.message, 'base64'),
    signature: Buffer.from(quote.signature, 'base64'),
  });
  const createAta = createAssociatedTokenAccountIdempotentInstruction(owner, ownerUsdc, owner, usdcMint);
  const builder = (program.methods as any)
    .stake(
      new anchor.BN(amountUnits.toString()),
      quote.entryIndexBps,
      new anchor.BN(String(quote.nonce)),
      new anchor.BN(String(quote.expiry)),
    )
    .accountsPartial({
      config: configPda(),
      basket: basketPda(idBytes),
      vault: vaultPda(idBytes),
      position: positionPda(idBytes, owner),
      stakerUsdc: ownerUsdc,
      usdcMint,
      staker: owner,
      ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([createAta, ed25519]);
  return { idBytes, quote, builder, ownerUsdc };
}

export async function stakeWithOperator(basketId: string, amountUsdc: string | number): Promise<{ signature: string; owner: string }> {
  const { keypair, program } = operatorContext();
  const { builder } = await stakeBuilder(program, basketId, keypair.publicKey, amountUsdc);
  const signature = await builder.rpc();
  return { signature, owner: keypair.publicKey.toBase58() };
}

export async function prepareStakeTransaction(
  basketId: string,
  ownerAddress: string,
  amountUsdc: string | number,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; entryIndexBps: number }> {
  const owner = new PublicKey(ownerAddress);
  const { quote, builder } = await stakeBuilder(readonlyProgram(), basketId, owner, amountUsdc);
  const transaction = await builder.transaction() as Transaction;
  const latest = await connection.getLatestBlockhash('confirmed');
  transaction.feePayer = owner;
  transaction.recentBlockhash = latest.blockhash;
  return {
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    entryIndexBps: quote.entryIndexBps,
  };
}

async function claimBuilder(program: Program, basketId: string, owner: PublicKey): Promise<any> {
  const idBytes = basketIdBytes(basketId);
  const ownerUsdc = getAssociatedTokenAddressSync(usdcMint, owner);
  const createAta = createAssociatedTokenAccountIdempotentInstruction(owner, ownerUsdc, owner, usdcMint);
  return (program.methods as any)
    .claim()
    .accountsPartial({
      config: configPda(),
      basket: basketPda(idBytes),
      vault: vaultPda(idBytes),
      position: positionPda(idBytes, owner),
      claimerUsdc: ownerUsdc,
      usdcMint,
      claimer: owner,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([createAta]);
}

export async function claimWithOperator(basketId: string): Promise<{ signature: string; owner: string }> {
  const { keypair, program } = operatorContext();
  const signature = await (await claimBuilder(program, basketId, keypair.publicKey)).rpc();
  return { signature, owner: keypair.publicKey.toBase58() };
}

export async function sweepSurplusWithOperator(basketId: string): Promise<{
  signature: string;
  admin: string;
}> {
  const { keypair, program } = operatorContext();
  const idBytes = basketIdBytes(basketId);
  const signature = await (program.methods as any)
    .sweepSurplus()
    .accountsPartial({
      config: configPda(),
      basket: basketPda(idBytes),
      vault: vaultPda(idBytes),
      usdcMint,
      admin: keypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  return { signature, admin: keypair.publicKey.toBase58() };
}

export async function prepareClaimTransaction(
  basketId: string,
  ownerAddress: string,
): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number }> {
  const owner = new PublicKey(ownerAddress);
  const transaction = await (await claimBuilder(readonlyProgram(), basketId, owner)).transaction() as Transaction;
  const latest = await connection.getLatestBlockhash('confirmed');
  transaction.feePayer = owner;
  transaction.recentBlockhash = latest.blockhash;
  return {
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

function statusName(value: Record<string, unknown>): string {
  const key = Object.keys(value)[0] ?? 'unknown';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function formatBasketAccount(publicKey: PublicKey, account: any): Record<string, unknown> {
  return {
    publicKey: publicKey.toBase58(),
    basketIdHex: Buffer.from(account.basketId).toString('hex'),
    creator: (account.creator as PublicKey).toBase58(),
    status: statusName(account.status),
    settlementIndexBps: Number(account.settlementIndexBps),
    proposedIndexBps: Number(account.proposedIndexBps),
    settlementProposedAt: Number(account.settlementProposedAt),
    totalStaked: account.totalStaked.toString(),
    totalDeposited: account.totalDeposited.toString(),
    totalPositions: Number(account.totalPositions),
    claimedPositions: Number(account.claimedPositions),
    createdAt: Number(account.createdAt),
    items: account.items.map((item: any) => ({
      marketId: item.marketId,
      outcome: item.outcome === 1 ? 'YES' : 'NO',
      weightBps: Number(item.weightBps),
    })),
  };
}

export async function getBasket(basketId: string): Promise<Record<string, unknown> | null> {
  const idBytes = basketIdBytes(basketId);
  try {
    const program = readonlyProgram();
    const account = await (program.account as any).basket.fetch(basketPda(idBytes));
    return formatBasketAccount(basketPda(idBytes), account);
  } catch {
    return null;
  }
}

export async function listBaskets(): Promise<Record<string, unknown>[]> {
  const program = readonlyProgram();
  const accounts = await (program.account as any).basket.all();
  return accounts.map((entry: any) => formatBasketAccount(entry.publicKey, entry.account));
}

export async function getWalletPositions(ownerAddress: string): Promise<Record<string, unknown>[]> {
  const owner = new PublicKey(ownerAddress);
  const program = readonlyProgram();
  const accounts = await (program.account as any).position.all([
    { memcmp: { offset: 8, bytes: owner.toBase58() } },
  ]);
  return accounts.map((entry: any) => ({
    publicKey: entry.publicKey.toBase58(),
    basket: (entry.account.basket as PublicKey).toBase58(),
    owner: (entry.account.owner as PublicKey).toBase58(),
    stakeAmount: entry.account.stakeAmount.toString(),
    depositedAmount: entry.account.depositedAmount.toString(),
    entryIndexBps: Number(entry.account.entryIndexBps),
    claimed: Boolean(entry.account.claimed),
  }));
}

export const escrowInfo = {
  programId: programId.toBase58(),
  configPda: configPda().toBase58(),
  usdcMint: usdcMint.toBase58(),
  rpcUrl: config.rpcUrl,
  cluster: config.cluster,
};
