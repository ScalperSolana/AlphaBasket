import type { Connection } from "@solana/web3.js";

export type SolanaCluster = "localnet" | "devnet" | "mainnet-beta";

const GENESIS_HASHES = Object.freeze({
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
} as const);

/**
 * Prevents a trusted cluster label from being paired with an RPC for a
 * different public Solana network. Local validators have unique genesis hashes
 * and are intentionally excluded from the fixed-hash comparison.
 */
export async function assertSolanaRpcCluster(
  connection: Pick<Connection, "getGenesisHash">,
  expectedCluster: SolanaCluster,
  responsibility: "accounting" | "capital",
): Promise<string | null> {
  if (expectedCluster === "localnet") return null;
  const actual = await connection.getGenesisHash();
  const expected = GENESIS_HASHES[expectedCluster];
  if (actual !== expected) {
    throw new Error(
      `${responsibility} Solana RPC genesis hash does not match ${expectedCluster}`,
    );
  }
  return actual;
}

export const SOLANA_PUBLIC_GENESIS_HASHES = GENESIS_HASHES;
