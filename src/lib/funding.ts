/**
 * The one Solana-mainnet transaction a deposit needs.
 *
 * After an intent is accepted the backend returns a list of USDC transfers:
 * the spot allocation to the settlement wallet, the prediction allocation to
 * the bridge (when enabled), and the protocol deposit fee. The user signs a
 * single transaction carrying all of them, and the backend later verifies each
 * destination's finalized token-account delta. Building it here, from the
 * backend's own list, means the browser never decides where money goes; it only
 * renders that list for review and signs it.
 */

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";

import type { FundingTransfer } from "@/types/index-basket";

/** USDC on Solana has six decimals; the API's units are the same scale. */
export const USDC_DECIMALS = 6;

export function buildFundingTransaction(input: {
  readonly payer: PublicKey;
  readonly mint: PublicKey;
  readonly transfers: readonly FundingTransfer[];
}): Transaction {
  const transaction = new Transaction();
  const source = getAssociatedTokenAddressSync(input.mint, input.payer);

  for (const transfer of input.transfers) {
    const amount = BigInt(transfer.amount);
    if (amount <= 0n) continue;
    const owner = new PublicKey(transfer.destination);
    // Bridge deposit addresses may be program-derived, so allow off-curve owners.
    const destination = getAssociatedTokenAddressSync(input.mint, owner, true);
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(input.payer, destination, owner, input.mint),
      createTransferCheckedInstruction(source, input.mint, destination, input.payer, amount, USDC_DECIMALS),
    );
  }

  if (transaction.instructions.length === 0) {
    throw new Error("nothing to transfer");
  }
  return transaction;
}
