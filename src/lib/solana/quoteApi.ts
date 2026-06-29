import { PublicKey, Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { ENV } from '@/env';

/**
 * A backend-signed entry-index quote. The escrow program verifies the Ed25519
 * signature on-chain before recording the entry index, so users cannot forge a
 * favorable index.
 */
export type SignedQuote = {
  entryIndexBps: number;
  nonce: number;
  expiry: number;
  /** base58 pubkey of the quote signer (must match on-chain config.quote_signer). */
  signerPubkey: string;
  /** base64 of the canonical 82-byte message that was signed. */
  message: string;
  /** base64 of the Ed25519 signature. */
  signature: string;
};

/**
 * Canonical quote message the program rebuilds and compares against:
 * basket_id(32) | owner(32) | entry_index_bps(u16 LE) | nonce(u64 LE) | expiry(i64 LE)
 */
function buildQuoteMessage(
  basketIdBytes: Uint8Array,
  owner: PublicKey,
  entryIndexBps: number,
  nonce: number,
  expiry: number,
): Uint8Array {
  const buf = new Uint8Array(82);
  buf.set(basketIdBytes.slice(0, 32), 0);
  buf.set(owner.toBytes(), 32);
  const view = new DataView(buf.buffer);
  view.setUint16(64, entryIndexBps, true);
  view.setBigUint64(66, BigInt(nonce), true);
  view.setBigInt64(74, BigInt(expiry), true);
  return buf;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

export function isQuoteApiConfigured(): boolean {
  return ENV.QUOTE_API_URL.length > 0;
}

/**
 * Fetch a signed entry-index quote.
 *
 * Production: POST to the quote-signer service (VITE_QUOTE_API_URL).
 * Dev: if VITE_DEV_QUOTE_SIGNER_SECRET (a JSON array of 64 ints — a keypair
 * secret) is set, sign locally. This is DEV-ONLY and insecure (the signer key
 * would be exposed in the bundle); never set it in production.
 */
export async function getSignedQuote(args: {
  basketIdBytes: Uint8Array;
  owner: PublicKey;
  entryIndexBps: number;
}): Promise<SignedQuote> {
  const { basketIdBytes, owner, entryIndexBps } = args;

  if (isQuoteApiConfigured()) {
    const res = await fetch(`${ENV.QUOTE_API_URL}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        basketId: Buffer.from(basketIdBytes).toString('hex'),
        owner: owner.toBase58(),
        entryIndexBps,
      }),
    });
    if (!res.ok) {
      throw new Error(`Quote service returned ${res.status}`);
    }
    return (await res.json()) as SignedQuote;
  }

  // ---- DEV fallback: local signing (insecure, dev only) ----
  if (!ENV.DEV_QUOTE_SIGNER_SECRET) {
    throw new Error(
      'No quote signer available. Set VITE_QUOTE_API_URL (production) or VITE_DEV_QUOTE_SIGNER_SECRET (dev).',
    );
  }
  let secret: Uint8Array;
  try {
    secret = Uint8Array.from(JSON.parse(ENV.DEV_QUOTE_SIGNER_SECRET) as number[]);
  } catch {
    throw new Error('VITE_DEV_QUOTE_SIGNER_SECRET must be a JSON array of 64 integers.');
  }
  const signer = Keypair.fromSecretKey(secret);
  const nonce = Date.now();
  const expiry = Math.floor(Date.now() / 1000) + 120;
  const message = buildQuoteMessage(basketIdBytes, owner, entryIndexBps, nonce, expiry);
  const signature = nacl.sign.detached(message, signer.secretKey);

  return {
    entryIndexBps,
    nonce,
    expiry,
    signerPubkey: signer.publicKey.toBase58(),
    message: toBase64(message),
    signature: toBase64(signature),
  };
}
