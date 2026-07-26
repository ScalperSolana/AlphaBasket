import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

export type JupiterTokenAssetClass = "crypto" | "tokenized-equity" | "other";

export interface JupiterTokenMetadata {
  readonly mint: PublicKey;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly tokenProgram: PublicKey;
  readonly isVerified: boolean;
  readonly tags: readonly string[];
  readonly updatedAt: string | null;
}

export interface JupiterTokenDirectoryPort {
  lookup(mints: readonly PublicKey[]): Promise<readonly JupiterTokenMetadata[]>;
  requireVerified(mint: PublicKey): Promise<JupiterTokenMetadata>;
}

export interface JupiterSwapBuildRequest {
  readonly inputMint: PublicKey;
  readonly outputMint: PublicKey;
  readonly amountUnits: bigint;
  readonly taker: PublicKey;
  readonly slippageBps: number;
  readonly maxAccounts?: number;
  readonly destinationTokenAccount?: PublicKey;
  readonly mode?: "fast";
}

export interface JupiterApiAccountMeta {
  readonly pubkey: PublicKey;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface JupiterApiInstruction {
  readonly programId: PublicKey;
  readonly accounts: readonly JupiterApiAccountMeta[];
  readonly data: Uint8Array;
}

export interface JupiterSwapBuild {
  readonly inputMint: PublicKey;
  readonly outputMint: PublicKey;
  readonly inAmount: bigint;
  readonly quotedOutAmount: bigint;
  readonly minimumOutAmount: bigint;
  readonly slippageBps: number;
  readonly swapInstruction: JupiterApiInstruction;
  readonly setupInstructions: readonly JupiterApiInstruction[];
  readonly cleanupInstruction: JupiterApiInstruction | null;
  readonly otherInstructions: readonly JupiterApiInstruction[];
  readonly computeBudgetInstructions: readonly JupiterApiInstruction[];
  readonly addressesByLookupTableAddress: ReadonlyMap<PublicKey, readonly PublicKey[]>;
  readonly blockhashBytes: Uint8Array;
  readonly lastValidBlockHeight: number;
}

export interface JupiterSwapBuildPort {
  buildExactIn(request: JupiterSwapBuildRequest): Promise<JupiterSwapBuild>;
}

export interface JupiterSpotEligibility {
  readonly token: JupiterTokenMetadata;
  readonly route: JupiterSwapBuild;
}

export interface JupiterInstructionConverterPort {
  toTransactionInstruction(instruction: JupiterApiInstruction): TransactionInstruction;
}
