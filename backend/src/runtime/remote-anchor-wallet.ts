import { createHash } from "node:crypto";

import bs58 from "bs58";
import {
  Ed25519Program,
  Message,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Transaction as LegacyTransaction,
} from "@solana/web3.js";

import {
  COMPOSITION_DOMAIN,
} from "../contract/index.js";
import type { ComposerSignerPort } from "../composer/index.js";
import type { PolicyEnforcedSigner } from "../signer/index.js";
import type { SignerRole } from "../signer/index.js";

function discriminator(name: string): string {
  return createHash("sha256")
    .update(`global:${name}`, "utf8")
    .digest()
    .subarray(0, 8)
    .toString("hex");
}

export function alphaBasketMessageValidator(options: Readonly<{
  signer: PublicKey;
  programId: PublicKey;
  allowedInstructions: ReadonlySet<string>;
}>): (payload: Uint8Array) => void {
  const allowed = new Set([...options.allowedInstructions].map(discriminator));
  return (payload) => {
    const message = Message.from(payload);
    const signerIndex = message.accountKeys.findIndex((key) => key.equals(options.signer));
    if (signerIndex < 0 || signerIndex >= message.header.numRequiredSignatures) {
      throw new Error("configured remote key is not a required transaction signer");
    }
    let alphaBasketInstructions = 0;
    for (const instruction of message.instructions) {
      const program = message.accountKeys[instruction.programIdIndex];
      if (program === undefined) throw new Error("transaction message has an invalid program index");
      if (program.equals(Ed25519Program.programId)) continue;
      if (!program.equals(options.programId)) {
        throw new Error(`transaction invokes unapproved program ${program.toBase58()}`);
      }
      const data = Buffer.from(bs58.decode(instruction.data));
      if (data.byteLength < 8 || !allowed.has(data.subarray(0, 8).toString("hex"))) {
        throw new Error("transaction invokes an unapproved AlphaBasket instruction");
      }
      alphaBasketInstructions += 1;
    }
    if (alphaBasketInstructions !== 1) {
      throw new Error("transaction must contain exactly one approved AlphaBasket instruction");
    }
  };
}

export class RemoteAnchorWallet {
  public constructor(
    public readonly publicKey: PublicKey,
    private readonly signer: PolicyEnforcedSigner,
    private readonly options: Readonly<{
      role: SignerRole;
      domain: string;
      action: string;
      network: "localnet" | "devnet" | "mainnet-beta";
      programId: PublicKey;
    }>,
  ) {}

  public async signTransaction<TransactionType extends LegacyTransaction | VersionedTransaction>(
    transaction: TransactionType,
  ): Promise<TransactionType> {
    if (!(transaction instanceof Transaction)) {
      throw new TypeError("AlphaBasket remote Anchor wallet currently accepts legacy transactions only");
    }
    if (transaction.feePayer === undefined || !transaction.feePayer.equals(this.publicKey)) {
      throw new Error("remote Anchor transaction fee payer does not match its signer role");
    }
    if (transaction.recentBlockhash === undefined) {
      throw new Error("remote Anchor transaction is missing its recent blockhash");
    }
    const message = transaction.serializeMessage();
    const payloadHash = createHash("sha256").update(message).digest("hex");
    const envelope = await this.signer.sign({
      role: this.options.role,
      payload: message,
      context: {
        domain: this.options.domain,
        action: this.options.action,
        network: this.options.network,
        expiresAt: new Date(Date.now() + 120_000),
        programId: this.options.programId.toBase58(),
        intentHash: payloadHash,
      },
    });
    if (!Buffer.from(envelope.publicKey).equals(this.publicKey.toBuffer())) {
      throw new Error("remote Anchor signer returned a different public key");
    }
    transaction.addSignature(this.publicKey, Buffer.from(envelope.signature));
    if (!transaction.verifySignatures(false)) throw new Error("remote Anchor transaction signature is invalid");
    return transaction as TransactionType;
  }

  public async signAllTransactions<TransactionType extends LegacyTransaction | VersionedTransaction>(
    transactions: TransactionType[],
  ): Promise<TransactionType[]> {
    const signed: TransactionType[] = [];
    for (const transaction of transactions) signed.push(await this.signTransaction(transaction));
    return signed;
  }
}

export class PolicyComposerSigner implements ComposerSignerPort {
  public constructor(
    private readonly signer: PolicyEnforcedSigner,
    private readonly options: Readonly<{
      network: "localnet" | "devnet" | "mainnet-beta";
      programId: PublicKey;
    }>,
  ) {}

  public async sign(message: Uint8Array): Promise<{
    readonly publicKey: Uint8Array;
    readonly signature: Uint8Array;
  }> {
    if (
      message.byteLength <= COMPOSITION_DOMAIN.byteLength ||
      !Buffer.from(message.subarray(0, COMPOSITION_DOMAIN.byteLength)).equals(COMPOSITION_DOMAIN)
    ) {
      throw new TypeError("Composer signing payload is not an AlphaBasket composition");
    }
    const envelope = await this.signer.sign({
      role: "composer",
      payload: message,
      context: {
        domain: "alphabasket:composition:v1",
        action: "sign_composition",
        network: this.options.network,
        expiresAt: new Date(Date.now() + 120_000),
        programId: this.options.programId.toBase58(),
        intentHash: createHash("sha256").update(message).digest("hex"),
      },
    });
    return Object.freeze({
      publicKey: Uint8Array.from(envelope.publicKey),
      signature: Uint8Array.from(envelope.signature),
    });
  }
}
