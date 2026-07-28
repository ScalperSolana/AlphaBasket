import {
  ComputeBudgetProgram,
  Message,
  PublicKey,
  VersionedMessage,
} from "@solana/web3.js";
import bs58 from "bs58";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

function associatedToken(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** Defense-in-depth validator run immediately before the settlement KMS signs. */
export function solanaCapitalSplitMessageValidator(options: {
  readonly sourceOwner: PublicKey;
  readonly usdcMint: PublicKey;
  readonly maximumSplitUnits: bigint;
}): (payload: Uint8Array) => void {
  return (payload) => {
    const message = Message.from(Buffer.from(payload));
    if (!message.accountKeys[0]?.equals(options.sourceOwner)) {
      throw new Error("capital split fee payer is not the configured source owner");
    }
    const signerKeys = message.accountKeys.filter((_key, index) => message.isAccountSigner(index));
    if (signerKeys.length !== 1 || !signerKeys[0]?.equals(options.sourceOwner)) {
      throw new Error("capital split requires exactly the configured source signer");
    }
    if (message.instructions.length === 0 || message.instructions.length > 6) {
      throw new Error("capital split instruction count is outside policy");
    }
    const createdAccounts = new Set<string>();
    let transferred = 0n;
    for (const instruction of message.instructions) {
      const program = message.accountKeys[instruction.programIdIndex];
      if (program?.equals(ASSOCIATED_TOKEN_PROGRAM_ID) === true) {
        if (instruction.data !== "2" || instruction.accounts.length !== 6) {
          throw new Error("capital split contains a non-idempotent ATA instruction");
        }
        const [payerIndex, ataIndex, ownerIndex, mintIndex, systemIndex, tokenIndex] =
          instruction.accounts;
        const payer = message.accountKeys[payerIndex as number];
        const ata = message.accountKeys[ataIndex as number];
        const owner = message.accountKeys[ownerIndex as number];
        const mint = message.accountKeys[mintIndex as number];
        const system = message.accountKeys[systemIndex as number];
        const token = message.accountKeys[tokenIndex as number];
        if (
          payer === undefined ||
          ata === undefined ||
          owner === undefined ||
          mint === undefined ||
          system === undefined ||
          token === undefined ||
          !payer.equals(options.sourceOwner) ||
          !mint.equals(options.usdcMint) ||
          !system.equals(SYSTEM_PROGRAM_ID) ||
          !token.equals(TOKEN_PROGRAM_ID) ||
          !ata.equals(associatedToken(owner, mint))
        ) {
          throw new Error("capital split ATA creation violates policy");
        }
        createdAccounts.add(ata.toBase58());
        continue;
      }
      if (program?.equals(TOKEN_PROGRAM_ID) !== true) {
        throw new Error("capital split invokes an unapproved program");
      }
      const data = Buffer.from(bs58.decode(instruction.data));
      if (data.byteLength !== 10 || data.readUInt8(0) !== 12 || instruction.accounts.length !== 4) {
        throw new Error("capital split contains a non-TransferChecked token instruction");
      }
      const [sourceIndex, mintIndex, destinationIndex, ownerIndex] = instruction.accounts;
      const source = message.accountKeys[sourceIndex as number];
      const mint = message.accountKeys[mintIndex as number];
      const destination = message.accountKeys[destinationIndex as number];
      const owner = message.accountKeys[ownerIndex as number];
      if (
        source === undefined ||
        mint === undefined ||
        destination === undefined ||
        owner === undefined ||
        !source.equals(associatedToken(options.sourceOwner, options.usdcMint)) ||
        !mint.equals(options.usdcMint) ||
        !owner.equals(options.sourceOwner) ||
        !createdAccounts.has(destination.toBase58())
      ) {
        throw new Error("capital split transfer accounts violate policy");
      }
      const amount = data.readBigUInt64LE(1);
      if (amount <= 0n) throw new Error("capital split transfer amount must be positive");
      transferred += amount;
    }
    if (transferred <= 0n || transferred > options.maximumSplitUnits) {
      throw new Error("capital split total exceeds policy");
    }
  };
}

/**
 * Defense-in-depth policy for a Jupiter-produced v0 transaction. Route and
 * amount validation remains in JupiterSwapGateway; this KMS-side check ensures
 * the key can only sign a transaction whose fee payer/required signer is the
 * configured capital wallet.
 */
export function solanaJupiterSwapMessageValidator(options: {
  readonly sourceOwner: PublicKey;
  readonly aggregatorProgramId: PublicKey;
  readonly maximumMessageBytes?: number;
}): (payload: Uint8Array) => void {
  const maximumMessageBytes = options.maximumMessageBytes ?? 1_232;
  return (payload) => {
    if (payload.byteLength === 0 || payload.byteLength > maximumMessageBytes) {
      throw new Error("Jupiter transaction message size is outside policy");
    }
    const message = VersionedMessage.deserialize(Buffer.from(payload));
    if (message.version !== 0) {
      throw new Error("Jupiter capital signing requires a version-0 transaction");
    }
    if (!message.staticAccountKeys[0]?.equals(options.sourceOwner)) {
      throw new Error("Jupiter transaction fee payer is not the configured capital wallet");
    }
    const requiredSigners = message.staticAccountKeys.slice(
      0,
      message.header.numRequiredSignatures,
    );
    if (
      requiredSigners.length !== 1 ||
      !requiredSigners[0]?.equals(options.sourceOwner)
    ) {
      throw new Error(
        "Jupiter transaction must require exactly the configured capital signer",
      );
    }
    if (message.compiledInstructions.length === 0) {
      throw new Error("Jupiter transaction contains no instructions");
    }
    if (message.compiledInstructions.length > 32) {
      throw new Error("Jupiter transaction instruction count is outside policy");
    }
    const allowedPrograms = new Set([
      options.aggregatorProgramId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    ]);
    let aggregatorCalls = 0;
    for (const instruction of message.compiledInstructions) {
      const program = message.staticAccountKeys[instruction.programIdIndex];
      if (program === undefined || !allowedPrograms.has(program.toBase58())) {
        throw new Error(
          "Jupiter transaction invokes an unapproved top-level program",
        );
      }
      if (program.equals(options.aggregatorProgramId)) aggregatorCalls += 1;
    }
    if (aggregatorCalls !== 1) {
      throw new Error(
        "Jupiter transaction must invoke the configured aggregator exactly once",
      );
    }
  };
}
