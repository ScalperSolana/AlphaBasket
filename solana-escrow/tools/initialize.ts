/**
 * One-time initialization for AlphaBasket v2.
 *
 * Required env:
 *   ANCHOR_PROVIDER_URL, ANCHOR_WALLET, COMPOSER_SIGNER,
 *   BACKEND_SIGNER, PROTOCOL_TREASURY, SETTLEMENT_MINT
 *
 * Optional env (basis points):
 *   MAX_SLIPPAGE_BPS
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "../target/idl/polybaskets_escrow.json";

const BPF_UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

function requiredPublicKey(name: string): PublicKey {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Missing required environment variable: " + name);
  return new PublicKey(value);
}

function basisPoints(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error(name + " must be an integer from 0 to 10000");
  }
  return value;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(idl as anchor.Idl, provider);
  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  const [programData] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_UPGRADEABLE_LOADER_ID,
  );

  if (await provider.connection.getAccountInfo(config)) {
    throw new Error("Config is already initialized at " + config.toBase58());
  }

  const composerSigner = requiredPublicKey("COMPOSER_SIGNER");
  const backendSigner = requiredPublicKey("BACKEND_SIGNER");
  const protocolTreasury = requiredPublicKey("PROTOCOL_TREASURY");
  const settlementMint = requiredPublicKey("SETTLEMENT_MINT");
  const signature = await program.methods
    .initialize({
      composerSigner,
      backendSigner,
      protocolTreasury,
      settlementMint,
      maxSlippageBps: basisPoints("MAX_SLIPPAGE_BPS", 1_000),
    })
    .accountsStrict({
      config,
      admin: provider.wallet.publicKey,
      program: program.programId,
      programData,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("Program:          " + program.programId.toBase58());
  console.log("Config:           " + config.toBase58());
  console.log("Admin:            " + provider.wallet.publicKey.toBase58());
  console.log("Composer signer:  " + composerSigner.toBase58());
  console.log("Backend signer:   " + backendSigner.toBase58());
  console.log("Protocol treasury:" + protocolTreasury.toBase58());
  console.log("Settlement mint:  " + settlementMint.toBase58());
  console.log("Transaction:      " + signature);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
