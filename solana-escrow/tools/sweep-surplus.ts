/**
 * Sweep a fully-claimed basket's remaining USDC to Config.treasury_usdc.
 *
 * Env: ANCHOR_PROVIDER_URL, ANCHOR_WALLET (= config admin)
 * Usage: npx tsx tools/sweep-surplus.ts <basketIdString>
 */
import * as anchor from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import idl from "../target/idl/polybaskets_escrow.json";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(idl as anchor.Idl, provider);

  const basketIdString = process.argv[2];
  if (!basketIdString) throw new Error("Usage: npx tsx tools/sweep-surplus.ts <basketIdString>");

  const idBytes = createHash("sha256").update(basketIdString).digest();
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [basket] = PublicKey.findProgramAddressSync([Buffer.from("basket"), idBytes], program.programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), idBytes], program.programId);
  const configAccount = await (program.account as any).config.fetch(config);
  const usdcMint = configAccount.usdcMint as PublicKey;

  const signature = await (program.methods as any)
    .sweepSurplus()
    .accountsPartial({
      config,
      basket,
      vault,
      usdcMint,
      admin: provider.wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log("Basket surplus swept:", basketIdString);
  console.log("tx:", signature);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
