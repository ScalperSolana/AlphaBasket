import { Message, PublicKey } from "@solana/web3.js";
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
