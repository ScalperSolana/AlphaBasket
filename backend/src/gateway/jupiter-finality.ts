import type {
  Connection,
  ParsedTransactionWithMeta,
  TokenBalance,
} from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

export interface JupiterSwapFinalityRequest {
  readonly signature: string;
  readonly taker: PublicKey;
  readonly inputMint: PublicKey;
  readonly outputMint: PublicKey;
  readonly requestedInputUnits: bigint;
  readonly reportedInputUnits: bigint;
  readonly reportedOutputUnits: bigint;
}

export interface JupiterSwapFinalityResult {
  readonly finalizedSlot: bigint;
  readonly inputDebitUnits: bigint;
  readonly outputCreditUnits: bigint;
}

export interface JupiterSwapFinalityPort {
  verifyFinalized(
    request: JupiterSwapFinalityRequest,
  ): Promise<JupiterSwapFinalityResult>;
}

function ownerBalances(
  balances: readonly TokenBalance[] | null | undefined,
  owner: string,
): ReadonlyMap<string, bigint> {
  const result = new Map<string, bigint>();
  for (const balance of balances ?? []) {
    if (balance.owner !== owner) continue;
    const amount = BigInt(balance.uiTokenAmount.amount);
    result.set(balance.mint, (result.get(balance.mint) ?? 0n) + amount);
  }
  return result;
}

function tokenDelta(
  before: ReadonlyMap<string, bigint>,
  after: ReadonlyMap<string, bigint>,
  mint: string,
): bigint {
  return (after.get(mint) ?? 0n) - (before.get(mint) ?? 0n);
}

function assertTakerParticipated(
  transaction: ParsedTransactionWithMeta,
  taker: PublicKey,
): void {
  const account = transaction.transaction.message.accountKeys.find(
    (item) => item.pubkey.equals(taker),
  );
  if (account === undefined || !account.signer || !account.writable) {
    throw new Error(
      "finalized Jupiter transaction does not contain the configured writable taker signer",
    );
  }
}

/**
 * Independently verifies the Jupiter API result against finalized mainnet
 * state. Accounting must never rely on the provider's HTTP response alone.
 *
 * Spot assets are held as SPL tokens by the configured settlement owner. A
 * native-SOL route that unwraps WSOL therefore fails closed here rather than
 * creating a holding the token-account reconciler cannot observe.
 */
export class Web3JupiterSwapFinalityVerifier
implements JupiterSwapFinalityPort {
  public constructor(private readonly connection: Connection) {}

  public async verifyFinalized(
    request: JupiterSwapFinalityRequest,
  ): Promise<JupiterSwapFinalityResult> {
    if (
      request.requestedInputUnits <= 0n ||
      request.reportedInputUnits <= 0n ||
      request.reportedInputUnits > request.requestedInputUnits ||
      request.reportedOutputUnits <= 0n
    ) {
      throw new RangeError("reported Jupiter fill amounts are invalid");
    }
    const transaction = await this.connection.getParsedTransaction(
      request.signature,
      {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      },
    );
    if (transaction === null || transaction.meta?.err !== null) {
      throw new Error(
        "Jupiter transaction is not finalized and successful on capital Solana",
      );
    }
    assertTakerParticipated(transaction, request.taker);

    const owner = request.taker.toBase58();
    const before = ownerBalances(transaction.meta.preTokenBalances, owner);
    const after = ownerBalances(transaction.meta.postTokenBalances, owner);
    const inputMint = request.inputMint.toBase58();
    const outputMint = request.outputMint.toBase58();
    const inputDebit = -tokenDelta(before, after, inputMint);
    const outputCredit = tokenDelta(before, after, outputMint);
    if (
      inputDebit < request.reportedInputUnits ||
      inputDebit > request.requestedInputUnits
    ) {
      throw new Error(
        "finalized Jupiter input-token debit does not reconcile with the reported fill",
      );
    }
    if (outputCredit !== request.reportedOutputUnits) {
      throw new Error(
        "finalized Jupiter output-token credit does not reconcile with the reported fill",
      );
    }

    const observedMints = new Set([...before.keys(), ...after.keys()]);
    for (const mint of observedMints) {
      if (mint === inputMint) continue;
      if (tokenDelta(before, after, mint) < 0n) {
        throw new Error(
          `finalized Jupiter transaction debited an unexpected taker token ${mint}`,
        );
      }
    }
    return Object.freeze({
      finalizedSlot: BigInt(transaction.slot),
      inputDebitUnits: inputDebit,
      outputCreditUnits: outputCredit,
    });
  }
}
