import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { startAnchor, Clock, BanksClient, ProgramTestContext } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  AccountLayout,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import { readFileSync } from "node:fs";
import type { PolybasketsEscrow } from "../target/types/polybaskets_escrow";

// Loaded via fs (avoids JSON import-attribute issues under the ESM loader).
const IDL = JSON.parse(readFileSync("target/idl/polybaskets_escrow.json", "utf8"));

const DECIMALS = 6;
const ONE_USDC = 1_000_000;
const CHALLENGE_WINDOW_SECS = 12 * 60; // 720s — must match the on-chain constant.
// Far-future expiry so warping the clock forward never expires a quote.
const FAR_EXPIRY = 4_102_444_800n; // 2100-01-01

describe("polybaskets-escrow (bankrun)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let banksClient: BanksClient;
  let program: Program<PolybasketsEscrow>;
  let payer: Keypair;

  const oracleAuthority = Keypair.generate();
  const quoteSigner = Keypair.generate();
  const user = Keypair.generate();

  let mint: PublicKey;
  let userUsdc: PublicKey;
  let configPda: PublicKey;

  const basketPda = (id: Buffer) =>
    PublicKey.findProgramAddressSync([Buffer.from("basket"), id], program.programId)[0];
  const vaultPda = (id: Buffer) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), id], program.programId)[0];
  const positionPda = (id: Buffer, owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("position"), id, owner.toBuffer()], program.programId)[0];

  const newBasketId = () => Buffer.from(Keypair.generate().publicKey.toBytes());
  const ITEMS = [
    { marketId: "100", outcome: 1, weightBps: 6000 },
    { marketId: "200", outcome: 0, weightBps: 4000 },
  ];

  // ---- helpers ----
  const sendTx = (ixs: TransactionInstruction[], signers: Keypair[] = []) => {
    const tx = new Transaction().add(...ixs);
    return provider.sendAndConfirm!(tx, signers);
  };

  /**
   * Process a transaction expecting it to FAIL, and return the program logs.
   * Uses banksClient directly because anchor-bankrun's thrown SendTransactionError
   * drops the logs against newer @solana/web3.js.
   */
  async function expectRevert(ixs: TransactionInstruction[], signers: Keypair[], pattern: RegExp) {
    // bankrun doesn't advance the blockhash, so a repeated identical tx is dropped
    // as a duplicate before execution (no logs). A random compute-budget ix makes
    // each tx unique. Placed first, so any ed25519-before-stake ordering still holds.
    const salt = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(Math.random() * 1_000_000_000) });
    const tx = new Transaction().add(salt, ...ixs);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await banksClient.getLatestBlockhash())![0];
    tx.sign(payer, ...signers);
    const res = await banksClient.tryProcessTransaction(tx);
    assert.isNotNull(res.result, "expected the transaction to fail");
    const logs = (res.meta?.logMessages ?? []).join("\n");
    assert.match(logs, pattern, `logs:\n${logs}`);
  }

  async function createMint(): Promise<PublicKey> {
    const mintKp = Keypair.generate();
    const rent = await banksClient.getRent();
    const lamports = Number(rent.minimumBalance(BigInt(MINT_SIZE)));
    await sendTx(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mintKp.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mintKp.publicKey, DECIMALS, payer.publicKey, null),
      ],
      [mintKp],
    );
    return mintKp.publicKey;
  }

  async function createAta(owner: PublicKey): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    await sendTx([createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint)]);
    return ata;
  }

  const mintToAta = (ata: PublicKey, amount: number) =>
    sendTx([createMintToInstruction(mint, ata, payer.publicKey, amount)]);

  async function tokenBalance(ata: PublicKey): Promise<bigint> {
    const acct = await banksClient.getAccount(ata as unknown as Uint8Array); // impl calls .toBytes()
    if (!acct) return 0n;
    return AccountLayout.decode(Buffer.from(acct.data)).amount;
  }

  const fundSol = (to: PublicKey, sol: number) =>
    sendTx([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: sol * 1_000_000_000 })]);

  /** Fast-forward the bankrun clock by `secs` seconds. */
  async function warpBy(secs: number) {
    const c = await banksClient.getClock();
    context.setClock(
      new Clock(c.slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp + BigInt(secs)),
    );
  }

  // Canonical quote message: basket_id(32)+owner(32)+entryBps(u16 LE)+nonce(u64 LE)+expiry(i64 LE)
  function quoteMessage(basketId: Buffer, owner: PublicKey, entryBps: number, nonce: bigint, expiry: bigint): Buffer {
    const b = Buffer.alloc(82);
    basketId.copy(b, 0);
    owner.toBuffer().copy(b, 32);
    b.writeUInt16LE(entryBps, 64);
    b.writeBigUInt64LE(nonce, 66);
    b.writeBigInt64LE(expiry, 74);
    return b;
  }

  const ed25519Ix = (signer: Keypair, message: Buffer) =>
    Ed25519Program.createInstructionWithPrivateKey({ privateKey: signer.secretKey, message });

  /** Build the [ed25519-verify, stake] instruction pair. */
  async function stakeIxs(opts: {
    basketId: Buffer;
    staker: Keypair;
    stakerUsdc: PublicKey;
    amount: number;
    entryBps: number;
    nonce: bigint;
    quoteSignerKp?: Keypair;
    quoteOverrideMsg?: Buffer;
  }): Promise<TransactionInstruction[]> {
    const { basketId, staker, stakerUsdc, amount, entryBps, nonce } = opts;
    const msg = opts.quoteOverrideMsg ?? quoteMessage(basketId, staker.publicKey, entryBps, nonce, FAR_EXPIRY);
    const edIx = ed25519Ix(opts.quoteSignerKp ?? quoteSigner, msg);
    const stakeIx = await program.methods
      .stake(new BN(amount), entryBps, new BN(nonce.toString()), new BN(FAR_EXPIRY.toString()))
      .accounts({
        config: configPda,
        basket: basketPda(basketId),
        vault: vaultPda(basketId),
        position: positionPda(basketId, staker.publicKey),
        stakerUsdc,
        usdcMint: mint,
        staker: staker.publicKey,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return [edIx, stakeIx];
  }

  const stake = async (opts: Parameters<typeof stakeIxs>[0]) => sendTx(await stakeIxs(opts), [opts.staker]);

  async function createBasket(basketId: Buffer) {
    await program.methods
      .createBasket([...basketId], ITEMS)
      .accounts({
        config: configPda,
        basket: basketPda(basketId),
        vault: vaultPda(basketId),
        usdcMint: mint,
        creator: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  const settleAccounts = (basketId: Buffer, oracle: PublicKey) => ({
    config: configPda,
    basket: basketPda(basketId),
    oracleAuthority: oracle,
  });

  const proposeIx = (basketId: Buffer, bps: number, oracle: PublicKey) =>
    program.methods.proposeSettlement(bps).accounts(settleAccounts(basketId, oracle)).instruction();
  const finalizeIx = (basketId: Buffer, oracle: PublicKey) =>
    program.methods.finalizeSettlement().accounts(settleAccounts(basketId, oracle)).instruction();

  const propose = (basketId: Buffer, bps: number) =>
    program.methods.proposeSettlement(bps).accounts(settleAccounts(basketId, oracleAuthority.publicKey)).signers([oracleAuthority]).rpc();
  const finalize = (basketId: Buffer) =>
    program.methods.finalizeSettlement().accounts(settleAccounts(basketId, oracleAuthority.publicKey)).signers([oracleAuthority]).rpc();

  /** Propose, warp past the 12-min window, then finalize. */
  async function settle(basketId: Buffer, bps: number) {
    await propose(basketId, bps);
    await warpBy(CHALLENGE_WINDOW_SECS + 1);
    await finalize(basketId);
  }

  const claimAccounts = (basketId: Buffer) => ({
    config: configPda,
    basket: basketPda(basketId),
    vault: vaultPda(basketId),
    position: positionPda(basketId, user.publicKey),
    claimerUsdc: userUsdc,
    usdcMint: mint,
    claimer: user.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const claimIx = (basketId: Buffer) => program.methods.claim().accounts(claimAccounts(basketId)).instruction();
  const claim = (basketId: Buffer) => program.methods.claim().accounts(claimAccounts(basketId)).signers([user]).rpc();

  const fund = (basketId: Buffer, funderUsdc: PublicKey, amount: number) =>
    program.methods
      .fundBasket(new BN(amount))
      .accounts({
        config: configPda,
        basket: basketPda(basketId),
        vault: vaultPda(basketId),
        funderUsdc,
        usdcMint: mint,
        funder: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

  before(async () => {
    context = await startAnchor("", [], []);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    banksClient = context.banksClient;
    program = new Program<PolybasketsEscrow>(IDL as anchor.Idl, provider);
    payer = (provider.wallet as anchor.Wallet).payer;

    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

    await fundSol(user.publicKey, 5);
    mint = await createMint();
    userUsdc = await createAta(user.publicKey);
    await mintToAta(userUsdc, 1_000 * ONE_USDC);

    await program.methods
      .initialize(oracleAuthority.publicKey, quoteSigner.publicKey, mint)
      .accounts({ config: configPda, admin: payer.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
  });

  it("full happy path: stake -> settle -> fund -> claim with profit", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);

    await stake({ basketId, staker: user, stakerUsdc: userUsdc, amount: 100 * ONE_USDC, entryBps: 6000, nonce: 1n });
    assert.equal(Number(await tokenBalance(vaultPda(basketId))), 100 * ONE_USDC, "vault holds the stake");

    await settle(basketId, 9000); // payout = 100 * 9000/6000 = 150

    const houseUsdc = await createAta(payer.publicKey);
    await mintToAta(houseUsdc, 50 * ONE_USDC);
    await fund(basketId, houseUsdc, 50 * ONE_USDC);

    const before = Number(await tokenBalance(userUsdc));
    await claim(basketId);
    const after = Number(await tokenBalance(userUsdc));
    assert.equal(after - before, 150 * ONE_USDC, "payout = stake * settlement/entry");
  });

  it("rejects a forged quote (wrong signer)", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    const ixs = await stakeIxs({
      basketId, staker: user, stakerUsdc: userUsdc, amount: 10 * ONE_USDC, entryBps: 5000, nonce: 10n,
      quoteSignerKp: Keypair.generate(),
    });
    await expectRevert(ixs, [user], /UnauthorizedQuoteSigner/);
  });

  it("rejects a quote whose message doesn't match the args", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    const wrongMsg = quoteMessage(basketId, user.publicKey, 5000, 11n, FAR_EXPIRY); // signs 5000
    const ixs = await stakeIxs({
      basketId, staker: user, stakerUsdc: userUsdc, amount: 10 * ONE_USDC, entryBps: 4000, nonce: 11n,
      quoteOverrideMsg: wrongMsg,
    });
    await expectRevert(ixs, [user], /QuoteMismatch/);
  });

  it("rejects claim before settlement", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    await stake({ basketId, staker: user, stakerUsdc: userUsdc, amount: 10 * ONE_USDC, entryBps: 5000, nonce: 20n });
    await expectRevert([await claimIx(basketId)], [user], /NotSettled/);
  });

  it("rejects settlement from a non-oracle signer", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    const notOracle = Keypair.generate();
    await expectRevert([await proposeIx(basketId, 5000, notOracle.publicKey)], [notOracle], /has_one|ConstraintHasOne|2001/i);
  });

  it("enforces the 12-minute challenge window (clock warp): finalize too early reverts, then succeeds", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    await stake({ basketId, staker: user, stakerUsdc: userUsdc, amount: 10 * ONE_USDC, entryBps: 5000, nonce: 40n });

    await propose(basketId, 5000);

    // Immediately: window open -> revert.
    await expectRevert([await finalizeIx(basketId, oracleAuthority.publicKey)], [oracleAuthority], /ChallengeWindowActive/);

    // Warp 11 minutes — short of 12 -> still revert.
    await warpBy(11 * 60);
    await expectRevert([await finalizeIx(basketId, oracleAuthority.publicKey)], [oracleAuthority], /ChallengeWindowActive/);

    // Warp past 12 min total -> succeeds.
    await warpBy(90);
    await finalize(basketId);
    const basketAcct = await (program.account as any).basket.fetch(basketPda(basketId));
    assert.equal(basketAcct.settlementIndexBps, 5000, "settlement promoted from proposed");
  });

  it("rejects finalize with no active proposal", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    await expectRevert([await finalizeIx(basketId, oracleAuthority.publicKey)], [oracleAuthority], /NoActiveProposal/);
  });

  it("rejects an underfunded claim, then succeeds after funding", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    await stake({ basketId, staker: user, stakerUsdc: userUsdc, amount: 100 * ONE_USDC, entryBps: 5000, nonce: 30n });

    await settle(basketId, 10000); // payout 200, vault has 100 -> underfunded

    await expectRevert([await claimIx(basketId)], [user], /InsufficientVaultLiquidity/);

    const houseUsdc = getAssociatedTokenAddressSync(mint, payer.publicKey);
    await mintToAta(houseUsdc, 100 * ONE_USDC);
    await fund(basketId, houseUsdc, 100 * ONE_USDC);
    await claim(basketId);

    await expectRevert([await claimIx(basketId)], [user], /AlreadyClaimed/);
  });
});
