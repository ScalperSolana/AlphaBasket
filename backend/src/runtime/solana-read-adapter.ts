import {
  BorshCoder,
  EventParser,
  type Idl,
} from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  type Finality,
  type VersionedTransactionResponse,
} from "@solana/web3.js";

import type {
  DecodedAccount,
  DecodedEvent,
  ProgramAccountSnapshot,
  SignatureInfo,
  SolanaProgramAccount,
  SolanaProgramDecoderPort,
  SolanaReadRpcPort,
  SolanaTransaction,
} from "../indexer/types.js";

function millisecondsFromSolanaSeconds(value: number | null | undefined): bigint | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Solana block time is not a non-negative safe integer");
  }
  return BigInt(value) * 1_000n;
}

function jsonSafe(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("Decoded Solana number is not a safe integer");
    }
    return value;
  }
  if (value instanceof PublicKey) {
    return value.toBase58();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    value.constructor?.name === "BN"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }
  if (typeof value === "object" && value !== null) {
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError(`Unsafe decoded Solana object key: ${key}`);
      }
      output[key] = jsonSafe(nested);
    }
    return output;
  }
  throw new TypeError(`Unsupported decoded Solana value: ${typeof value}`);
}

function jsonSafeRecord(value: unknown): Readonly<Record<string, unknown>> {
  const normalized = jsonSafe(value);
  if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
    throw new TypeError("Decoded Solana object must be a record");
  }
  return Object.freeze(normalized as Record<string, unknown>);
}

export class Web3SolanaReadRpc implements SolanaReadRpcPort {
  public constructor(
    private readonly connection: Connection,
    private readonly commitment: Finality = "finalized",
  ) {
    if (commitment !== "finalized") {
      throw new TypeError("AlphaBasket indexing requires finalized Solana reads");
    }
  }

  public async getProgramAccounts(programId: string): Promise<ProgramAccountSnapshot> {
    const owner = new PublicKey(programId);
    const response = await this.connection.getProgramAccounts(owner, {
      commitment: this.commitment,
      withContext: true,
    });
    return Object.freeze({
      contextSlot: BigInt(response.context.slot),
      accounts: Object.freeze(
        response.value.map(({ pubkey, account }): SolanaProgramAccount =>
          Object.freeze({
            address: pubkey.toBase58(),
            owner: account.owner.toBase58(),
            lamports: BigInt(account.lamports),
            data: Uint8Array.from(account.data),
          }),
        ),
      ),
    });
  }

  public async getSignaturesForAddress(
    address: string,
    options: { readonly before: string | null; readonly limit: number },
  ): Promise<readonly SignatureInfo[]> {
    const result = await this.connection.getSignaturesForAddress(
      new PublicKey(address),
      {
        ...(options.before === null ? {} : { before: options.before }),
        limit: options.limit,
      },
      this.commitment,
    );
    return Object.freeze(
      result.map((entry): SignatureInfo =>
        Object.freeze({
          signature: entry.signature,
          slot: BigInt(entry.slot),
          failed: entry.err !== null,
          blockTimeMs: millisecondsFromSolanaSeconds(entry.blockTime),
        }),
      ),
    );
  }

  public async getTransaction(signature: string): Promise<SolanaTransaction | null> {
    const transaction = await this.connection.getTransaction(signature, {
      commitment: this.commitment,
      maxSupportedTransactionVersion: 0,
    });
    if (transaction === null) {
      return null;
    }
    if (transaction.meta?.err !== null) {
      throw new Error(`Solana RPC returned a failed transaction for ${signature}`);
    }
    return Object.freeze({
      signature,
      slot: BigInt(transaction.slot),
      blockTimeMs: millisecondsFromSolanaSeconds(transaction.blockTime),
      payload: transaction,
    });
  }
}

export class AnchorProgramDecoder implements SolanaProgramDecoderPort {
  private readonly coder: BorshCoder;
  private readonly eventParser: EventParser;
  private readonly accountNameByDiscriminator: ReadonlyMap<string, string>;

  public constructor(programId: PublicKey, idl: Idl) {
    this.coder = new BorshCoder(idl);
    this.eventParser = new EventParser(programId, this.coder);
    const accounts = idl.accounts ?? [];
    this.accountNameByDiscriminator = new Map(
      accounts.map((account) => [Buffer.from(account.discriminator).toString("hex"), account.name]),
    );
  }

  public decodeAccount(account: SolanaProgramAccount): DecodedAccount | null {
    if (account.data.byteLength < 8) {
      return null;
    }
    const discriminator = Buffer.from(account.data.subarray(0, 8)).toString("hex");
    const name = this.accountNameByDiscriminator.get(discriminator);
    if (name === undefined) {
      return null;
    }
    const decoded = this.coder.accounts.decode(name, Buffer.from(account.data));
    return Object.freeze({ kind: name, data: jsonSafeRecord(decoded) });
  }

  public decodeEvents(transaction: SolanaTransaction): readonly DecodedEvent[] {
    const payload = transaction.payload as VersionedTransactionResponse;
    const logs = payload.meta?.logMessages;
    if (logs === null || logs === undefined) {
      return [];
    }
    return Object.freeze(
      [...this.eventParser.parseLogs(logs)].map((event): DecodedEvent =>
        Object.freeze({
          name: event.name,
          data: jsonSafeRecord(event.data),
        }),
      ),
    );
  }
}

export const normalizeDecodedSolanaValue = jsonSafe;
