/**
 * One-time initialization for a newly deployed PolyBaskets program.
 *
 * Required env:
 *   ANCHOR_PROVIDER_URL, ANCHOR_WALLET, USDC_MINT,
 *   ORACLE_AUTHORITY, QUOTE_SIGNER
 */
import * as anchor from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "../target/idl/polybaskets_escrow.json";

function requiredPublicKey(name: string): PublicKey {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return new PublicKey(value);
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(idl as anchor.Idl, provider);

  const oracleAuthority = requiredPublicKey("ORACLE_AUTHORITY");
  const quoteSigner = requiredPublicKey("QUOTE_SIGNER");
  const usdcMint = requiredPublicKey("USDC_MINT");
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [treasuryUsdc] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury-usdc")],
    program.programId,
  );

  if (await provider.connection.getAccountInfo(config)) {
    throw new Error(`Config is already initialized at ${config.toBase58()}`);
  }

  const signature = await program.methods
    .initialize(oracleAuthority, quoteSigner)
    .accountsStrict({
      config,
      treasuryUsdc,
      usdcMint,
      admin: provider.wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`Program:       ${program.programId.toBase58()}`);
  console.log(`Config:        ${config.toBase58()}`);
  console.log(`Treasury USDC: ${treasuryUsdc.toBase58()}`);
  console.log(`Admin:         ${provider.wallet.publicKey.toBase58()}`);
  console.log(`Transaction:   ${signature}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
