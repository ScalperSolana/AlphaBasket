import type { Connection, ParsedTransactionWithMeta } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import type {
  SolanaBridgeReceiptPort,
  SolanaFundingProof,
  SolanaFundingVerifierPort,
} from "../execution/types.js";

function tokenBalance(transaction: ParsedTransactionWithMeta, owner: string, mint: string, phase: "pre" | "post"): bigint {
  const balances = phase === "pre" ? transaction.meta?.preTokenBalances : transaction.meta?.postTokenBalances;
  let total = 0n;
  for (const balance of balances ?? []) {
    if (balance.owner === owner && balance.mint === mint) total += BigInt(balance.uiTokenAmount.amount);
  }
  return total;
}

export class Web3SolanaFundingVerifier implements SolanaFundingVerifierPort {
  public constructor(private readonly connection: Connection) {}

  public async verifyFinalizedTransfer(request: {
    readonly signature: string;
    readonly expectedUser: string;
    readonly expectedBridgeAddress: string;
    readonly expectedMint: string;
    readonly expectedAmountUnits: bigint;
  }): Promise<SolanaFundingProof> {
    if (request.expectedAmountUnits <= 0n) throw new RangeError("expected funding amount must be positive");
    const user = new PublicKey(request.expectedUser);
    const bridge = new PublicKey(request.expectedBridgeAddress);
    const mint = new PublicKey(request.expectedMint);
    const transaction = await this.connection.getParsedTransaction(request.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (transaction === null || transaction.meta?.err !== null) throw new Error("Solana funding transaction is not finalized and successful");
    const userSigned = transaction.transaction.message.accountKeys.some((key) => key.signer && key.pubkey.equals(user));
    if (!userSigned) throw new Error("funding transaction was not signed by the intent user");
    const before = tokenBalance(transaction, bridge.toBase58(), mint.toBase58(), "pre");
    const after = tokenBalance(transaction, bridge.toBase58(), mint.toBase58(), "post");
    const delta = after - before;
    if (delta !== request.expectedAmountUnits) {
      throw new Error(`bridge USDC delta ${delta.toString()} does not equal expected amount ${request.expectedAmountUnits.toString()}`);
    }
    return Object.freeze({
      signature: request.signature,
      user: user.toBase58(),
      bridgeAddress: bridge.toBase58(),
      mint: mint.toBase58(),
      amountUnits: delta,
      finalizedSlot: BigInt(transaction.slot),
    });
  }
}

export class Web3SolanaBridgeReceiptVerifier implements SolanaBridgeReceiptPort {
  public constructor(private readonly connection: Connection) {}

  public async verifyReceived(request: {
    readonly bridgeAddress: string;
    readonly destination: string;
    readonly mint: string;
    readonly expectedMaximumUnits: bigint;
    readonly destinationTransactionHash: string | null;
  }): Promise<{ readonly amountUnits: bigint; readonly transactionSignature: string; readonly finalizedSlot: bigint }> {
    if (request.destinationTransactionHash === null) throw new Error("completed bridge transfer is missing its Solana transaction signature");
    if (request.expectedMaximumUnits <= 0n) throw new RangeError("expected bridge receipt must be positive");
    const destination = new PublicKey(request.destination);
    const mint = new PublicKey(request.mint);
    const transaction = await this.connection.getParsedTransaction(request.destinationTransactionHash, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (transaction === null || transaction.meta?.err !== null) throw new Error("Solana bridge transaction is not finalized and successful");
    const before = tokenBalance(transaction, destination.toBase58(), mint.toBase58(), "pre");
    const after = tokenBalance(transaction, destination.toBase58(), mint.toBase58(), "post");
    const amount = after - before;
    if (amount <= 0n || amount > request.expectedMaximumUnits) throw new Error("Solana bridge receipt is outside the expected bounds");
    return Object.freeze({
      amountUnits: amount,
      transactionSignature: request.destinationTransactionHash,
      finalizedSlot: BigInt(transaction.slot),
    });
  }
}
