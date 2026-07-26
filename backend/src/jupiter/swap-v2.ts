import {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { z } from "zod";

import { JsonHttpClient } from "../polymarket/http-json.js";
import type {
  JupiterApiInstruction,
  JupiterInstructionConverterPort,
  JupiterSwapBuild,
  JupiterSwapBuildPort,
  JupiterSwapBuildRequest,
} from "./types.js";

export const JUPITER_AGGREGATOR_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);

const U64_MAX = (1n << 64n) - 1n;
const positiveIntegerString = z.string().regex(/^[1-9][0-9]*$/u);
const publicKeyString = z.string().refine((value) => {
  try {
    return !new PublicKey(value).equals(PublicKey.default);
  } catch {
    return false;
  }
}, "must be a non-zero Solana public key");
const base64Data = z.string().max(16_384).refine((value) => {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 && decoded.toString("base64") === value;
}, "must be canonical non-empty base64");

const accountSchema = z.object({
  pubkey: publicKeyString,
  isSigner: z.boolean(),
  isWritable: z.boolean(),
}).strict();

const instructionSchema = z.object({
  programId: publicKeyString,
  accounts: z.array(accountSchema).max(128),
  data: base64Data,
}).strict();

const routeStepSchema = z.object({
  percent: z.number().finite().min(0).max(100).optional(),
  bps: z.number().int().min(1).max(10_000),
  swapInfo: z.object({
    ammKey: publicKeyString,
    label: z.string().min(1).max(256),
    inputMint: publicKeyString,
    outputMint: publicKeyString,
    inAmount: positiveIntegerString,
    outAmount: positiveIntegerString,
  }).passthrough(),
}).passthrough();

const buildSchema = z.object({
  inputMint: publicKeyString,
  outputMint: publicKeyString,
  inAmount: positiveIntegerString,
  outAmount: positiveIntegerString,
  otherAmountThreshold: positiveIntegerString,
  swapMode: z.literal("ExactIn"),
  slippageBps: z.number().int().min(0).max(10_000),
  routePlan: z.array(routeStepSchema).min(1).max(64),
  computeBudgetInstructions: z.array(instructionSchema).max(8),
  setupInstructions: z.array(instructionSchema).max(16),
  swapInstruction: instructionSchema,
  cleanupInstruction: instructionSchema.nullable(),
  otherInstructions: z.array(instructionSchema).max(16),
  tipInstruction: instructionSchema.nullable(),
  addressesByLookupTableAddress: z.record(
    publicKeyString,
    z.array(publicKeyString).max(256),
  ).nullable(),
  blockhashWithMetadata: z.object({
    blockhash: z.array(z.number().int().min(0).max(255)).length(32),
    lastValidBlockHeight: z.number().int().nonnegative().safe(),
  }).passthrough(),
}).passthrough();

const validatedApiKey = (value: string): string => {
  const apiKey = value.trim();
  if (apiKey.length === 0 || apiKey.length > 512) {
    throw new TypeError("Jupiter API key must contain 1-512 characters");
  }
  return apiKey;
};

const toApiInstruction = (
  value: z.output<typeof instructionSchema>,
): JupiterApiInstruction =>
  Object.freeze({
    programId: new PublicKey(value.programId),
    accounts: Object.freeze(
      value.accounts.map((account) =>
        Object.freeze({
          pubkey: new PublicKey(account.pubkey),
          isSigner: account.isSigner,
          isWritable: account.isWritable,
        })),
    ),
    data: Uint8Array.from(Buffer.from(value.data, "base64")),
  });

function validateInstructionSigners(
  instructions: readonly JupiterApiInstruction[],
  taker: PublicKey,
): void {
  for (const instruction of instructions) {
    for (const account of instruction.accounts) {
      if (account.isSigner && !account.pubkey.equals(taker)) {
        throw new Error(
          `Jupiter build requested unexpected signer ${account.pubkey.toBase58()}`,
        );
      }
    }
  }
}

export class JupiterSwapV2Client
implements JupiterSwapBuildPort, JupiterInstructionConverterPort {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  public constructor(
    private readonly http: JsonHttpClient,
    apiKey: string,
    private readonly aggregatorProgramId = JUPITER_AGGREGATOR_PROGRAM_ID,
    baseUrl = "https://api.jup.ag/swap/v2",
  ) {
    this.apiKey = validatedApiKey(apiKey);
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    if (!this.baseUrl.startsWith("https://")) {
      throw new TypeError("Jupiter Swap API URL must use HTTPS");
    }
    if (
      !(this.aggregatorProgramId instanceof PublicKey) ||
      this.aggregatorProgramId.equals(PublicKey.default)
    ) {
      throw new TypeError("Jupiter aggregator program must be a non-zero PublicKey");
    }
  }

  public async buildExactIn(
    request: JupiterSwapBuildRequest,
  ): Promise<JupiterSwapBuild> {
    if (
      !(request.inputMint instanceof PublicKey) ||
      !(request.outputMint instanceof PublicKey) ||
      request.inputMint.equals(PublicKey.default) ||
      request.outputMint.equals(PublicKey.default) ||
      request.inputMint.equals(request.outputMint)
    ) {
      throw new TypeError("Jupiter input and output mints must be distinct non-zero PublicKeys");
    }
    if (
      typeof request.amountUnits !== "bigint" ||
      request.amountUnits <= 0n ||
      request.amountUnits > U64_MAX
    ) {
      throw new RangeError("Jupiter exact-in amount must be a positive u64");
    }
    if (
      !(request.taker instanceof PublicKey) ||
      request.taker.equals(PublicKey.default)
    ) {
      throw new TypeError("Jupiter taker must be a non-zero PublicKey");
    }
    if (
      !Number.isSafeInteger(request.slippageBps) ||
      request.slippageBps < 1 ||
      request.slippageBps > 2_000
    ) {
      throw new RangeError("Jupiter slippage must be between 1 and 2000 bps");
    }
    const maxAccounts = request.maxAccounts ?? 64;
    if (
      !Number.isSafeInteger(maxAccounts) ||
      maxAccounts < 1 ||
      maxAccounts > 64
    ) {
      throw new RangeError("Jupiter maxAccounts must be between 1 and 64");
    }
    if (
      request.destinationTokenAccount !== undefined &&
      (!(request.destinationTokenAccount instanceof PublicKey) ||
        request.destinationTokenAccount.equals(PublicKey.default))
    ) {
      throw new TypeError("Jupiter destination token account must be a non-zero PublicKey");
    }

    const query = new URLSearchParams({
      inputMint: request.inputMint.toBase58(),
      outputMint: request.outputMint.toBase58(),
      amount: request.amountUnits.toString(10),
      taker: request.taker.toBase58(),
      slippageBps: request.slippageBps.toString(10),
      maxAccounts: maxAccounts.toString(10),
      wrapAndUnwrapSol: "false",
      ...(request.destinationTokenAccount === undefined
        ? {}
        : { destinationTokenAccount: request.destinationTokenAccount.toBase58() }),
      ...(request.mode === undefined ? {} : { mode: request.mode }),
    });
    const raw = await this.http.get(
      `${this.baseUrl}/build?${query.toString()}`,
      buildSchema,
      { "x-api-key": this.apiKey },
    );
    if (
      raw.inputMint !== request.inputMint.toBase58() ||
      raw.outputMint !== request.outputMint.toBase58() ||
      BigInt(raw.inAmount) !== request.amountUnits ||
      raw.slippageBps !== request.slippageBps
    ) {
      throw new Error("Jupiter build response does not match the exact-in request");
    }
    const quotedOutAmount = BigInt(raw.outAmount);
    const minimumOutAmount = BigInt(raw.otherAmountThreshold);
    if (minimumOutAmount > quotedOutAmount) {
      throw new Error("Jupiter minimum output exceeds the quoted output");
    }
    if (raw.tipInstruction !== null) {
      throw new Error("Jupiter returned an unsolicited tip instruction");
    }

    const swapInstruction = toApiInstruction(raw.swapInstruction);
    if (!swapInstruction.programId.equals(this.aggregatorProgramId)) {
      throw new Error("Jupiter swap instruction targets an unexpected program");
    }
    const setupInstructions = raw.setupInstructions.map(toApiInstruction);
    const cleanupInstruction =
      raw.cleanupInstruction === null
        ? null
        : toApiInstruction(raw.cleanupInstruction);
    const otherInstructions = raw.otherInstructions.map(toApiInstruction);
    const computeBudgetInstructions =
      raw.computeBudgetInstructions.map(toApiInstruction);
    validateInstructionSigners(
      [
        ...computeBudgetInstructions,
        ...setupInstructions,
        swapInstruction,
        ...(cleanupInstruction === null ? [] : [cleanupInstruction]),
        ...otherInstructions,
      ],
      request.taker,
    );
    if (
      !swapInstruction.accounts.some(
        (account) => account.isSigner && account.pubkey.equals(request.taker),
      )
    ) {
      throw new Error("Jupiter swap instruction does not bind the requested taker");
    }

    const lookupTables = new Map<PublicKey, readonly PublicKey[]>();
    for (const [key, addresses] of Object.entries(
      raw.addressesByLookupTableAddress ?? {},
    )) {
      lookupTables.set(
        new PublicKey(key),
        Object.freeze(addresses.map((address) => new PublicKey(address))),
      );
    }
    return Object.freeze({
      inputMint: new PublicKey(raw.inputMint),
      outputMint: new PublicKey(raw.outputMint),
      inAmount: BigInt(raw.inAmount),
      quotedOutAmount,
      minimumOutAmount,
      slippageBps: raw.slippageBps,
      swapInstruction,
      setupInstructions: Object.freeze(setupInstructions),
      cleanupInstruction,
      otherInstructions: Object.freeze(otherInstructions),
      computeBudgetInstructions: Object.freeze(computeBudgetInstructions),
      addressesByLookupTableAddress: lookupTables,
      blockhashBytes: Uint8Array.from(raw.blockhashWithMetadata.blockhash),
      lastValidBlockHeight: raw.blockhashWithMetadata.lastValidBlockHeight,
    });
  }

  public toTransactionInstruction(
    instruction: JupiterApiInstruction,
  ): TransactionInstruction {
    return new TransactionInstruction({
      programId: instruction.programId,
      keys: instruction.accounts.map((account) => ({
        pubkey: account.pubkey,
        isSigner: account.isSigner,
        isWritable: account.isWritable,
      })),
      data: Buffer.from(instruction.data),
    });
  }
}
