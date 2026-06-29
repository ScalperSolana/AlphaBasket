import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import { PolybasketsEscrow } from "../target/types/polybaskets_escrow";

const DECIMALS = 6;
const ONE_USDC = 1_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("polybaskets-escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.polybasketsEscrow as Program<PolybasketsEscrow>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const admin = payer;
  const oracleAuthority = Keypair.generate();
  const quoteSigner = Keypair.generate();
  const user = Keypair.generate();

  let mint: PublicKey;
  let userUsdc: PublicKey;
  let configPda: PublicKey;

  const configSeeds = () => PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const basketPda = (id: Buffer) =>
    PublicKey.findProgramAddressSync([Buffer.from("basket"), id], program.programId)[0];
  const vaultPda = (id: Buffer) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), id], program.programId)[0];
  const positionPda = (id: Buffer, owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("position"), id, owner.toBuffer()], program.programId)[0];

  function quoteMessage(basketId: Buffer, owner: PublicKey, entryBps: number, nonce: bigint, expiry: bigint): Buffer {
    const b = Buffer.alloc(82);
    basketId.copy(b, 0);
    owner.toBuffer().copy(b, 32);
    b.writeUInt16LE(entryBps, 64);
    b.writeBigUInt64LE(nonce, 66);
    b.writeBigInt64LE(expiry, 74);
    return b;
  }

  function ed25519Ix(signer: Keypair, message: Buffer) {
    return Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer.secretKey,
      message,
    });
  }

  async function airdrop(pk: PublicKey, sol = 2) {
    const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  async function stakeTx(opts: {
    basketId: Buffer;
    staker: Keypair;
    stakerUsdc: PublicKey;
    amount: number;
    entryBps: number;
    nonce: bigint;
    expiry: bigint;
    quoteSignerKp?: Keypair;
    quoteOverrideMsg?: Buffer;
  }) {
    const { basketId, staker, stakerUsdc, amount, entryBps, nonce, expiry } = opts;
    const msg = opts.quoteOverrideMsg ?? quoteMessage(basketId, staker.publicKey, entryBps, nonce, expiry);
    const edIx = ed25519Ix(opts.quoteSignerKp ?? quoteSigner, msg);
    const stakeIx = await program.methods
      .stake(new BN(amount), entryBps, new BN(nonce.toString()), new BN(expiry.toString()))
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
    const tx = new Transaction().add(edIx).add(stakeIx);
    return provider.sendAndConfirm(tx, [staker]);
  }

  before(async () => {
    [configPda] = configSeeds();
    await airdrop(user.publicKey);
    await airdrop(oracleAuthority.publicKey);

    mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
    userUsdc = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, user.publicKey)).address;
    await mintTo(connection, payer, mint, userUsdc, payer, 1_000 * ONE_USDC);

    await program.methods
      .initialize(oracleAuthority.publicKey, quoteSigner.publicKey, mint)
      .accounts({ config: configPda, admin: admin.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
  });


  async function finalizeWhenAllowed(basketId: Buffer) {
    const accounts = {
      config: configPda,
      basket: basketPda(basketId),
      oracleAuthority: oracleAuthority.publicKey,
    };
    for (let i = 0; i < 20; i++) {
      try {
        await program.methods.finalizeSettlement().accounts(accounts).signers([oracleAuthority]).rpc();
        return;
      } catch (e) {
        if (!/ChallengeWindowActive/.test((e as Error).toString())) throw e;
        await sleep(1000);
      }
    }
    throw new Error("finalize never became allowed within timeout");
  }

  async function settle(basketId: Buffer, bps: number) {
    await program.methods
      .proposeSettlement(bps)
      .accounts({ config: configPda, basket: basketPda(basketId), oracleAuthority: oracleAuthority.publicKey })
      .signers([oracleAuthority])
      .rpc();
    await finalizeWhenAllowed(basketId);
  }

  const newBasketId = () => Buffer.from(Keypair.generate().publicKey.toBytes());

  async function createBasket(basketId: Buffer, creator = payer) {
    await program.methods
      .createBasket([...basketId])
      .accounts({
        config: configPda,
        basket: basketPda(basketId),
        vault: vaultPda(basketId),
        usdcMint: mint,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  it("user is able to claim from a settled basket", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);

    const entryBps = 6000;
    await stakeTx({
      basketId,
      staker: user,
      stakerUsdc: userUsdc,
      amount: 100 * ONE_USDC,
      entryBps,
      nonce: 1n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 300),
    });

    let vault = await getAccount(connection, vaultPda(basketId));
    assert.equal(Number(vault.amount), 100 * ONE_USDC, "vault holds the stake");

    await settle(basketId, 9000);

    const houseUsdc = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey)).address;
    await mintTo(connection, payer, mint, houseUsdc, payer, 50 * ONE_USDC);
    await program.methods
      .fundBasket(new BN(50 * ONE_USDC))
      .accounts({
        config: configPda,
        basket: basketPda(basketId),
        vault: vaultPda(basketId),
        funderUsdc: houseUsdc,
        usdcMint: mint,
        funder: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const before = Number((await getAccount(connection, userUsdc)).amount);
    await program.methods
      .claim()
      .accounts({
        config: configPda,
        basket: basketPda(basketId),
        vault: vaultPda(basketId),
        position: positionPda(basketId, user.publicKey),
        claimerUsdc: userUsdc,
        usdcMint: mint,
        claimer: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();
    const after = Number((await getAccount(connection, userUsdc)).amount);
    assert.equal(after - before, 150 * ONE_USDC, "payout = stake * settlement/entry");
  });

  it("rejects a forged quote", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    const forger = Keypair.generate();
    try {
      await stakeTx({
        basketId,
        staker: user,
        stakerUsdc: userUsdc,
        amount: 10 * ONE_USDC,
        entryBps: 5000,
        nonce: 10n,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 300),
        quoteSignerKp: forger,
      });
      assert.fail("forged quote should be rejected");
    } catch (e) {
      assert.match((e as Error).toString(), /UnauthorizedQuoteSigner|custom program error/i);
    }
  });

  it("rejects a quote whose message doesn't match the args", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 300);
    const wrongMsg = quoteMessage(basketId, user.publicKey, 5000, 11n, expiry);
    try {
      await stakeTx({
        basketId,
        staker: user,
        stakerUsdc: userUsdc,
        amount: 10 * ONE_USDC,
        entryBps: 4000,
        nonce: 11n,
        expiry,
        quoteOverrideMsg: wrongMsg,
      });
      assert.fail("mismatched quote should be rejected");
    } catch (e) {
      assert.match((e as Error).toString(), /QuoteMismatch|custom program error/i);
    }
  });

  it("rejects claim before settlement", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    await stakeTx({
      basketId,
      staker: user,
      stakerUsdc: userUsdc,
      amount: 10 * ONE_USDC,
      entryBps: 5000,
      nonce: 20n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 300),
    });
    try {
      await program.methods
        .claim()
        .accounts({
          config: configPda,
          basket: basketPda(basketId),
          vault: vaultPda(basketId),
          position: positionPda(basketId, user.publicKey),
          claimerUsdc: userUsdc,
          usdcMint: mint,
          claimer: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail("claim before settlement should fail");
    } catch (e) {
      assert.match((e as Error).toString(), /NotSettled|custom program error/i);
    }
  });

  it("rejects settlement from a non-oracle signer", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    const notOracle = Keypair.generate();
    await airdrop(notOracle.publicKey);
    try {
      await program.methods
        .proposeSettlement(5000)
        .accounts({ config: configPda, basket: basketPda(basketId), oracleAuthority: notOracle.publicKey })
        .signers([notOracle])
        .rpc();
      assert.fail("non-oracle settlement should fail");
    } catch (e) {
      assert.match((e as Error).toString(), /has_one|ConstraintHasOne|custom program error|unknown signer/i);
    }
  });

  it("ensures the challenge window is enforced", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    await stakeTx({
      basketId,
      staker: user,
      stakerUsdc: userUsdc,
      amount: 10 * ONE_USDC,
      entryBps: 5000,
      nonce: 40n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 300),
    });

    await program.methods
      .proposeSettlement(5000)
      .accounts({ config: configPda, basket: basketPda(basketId), oracleAuthority: oracleAuthority.publicKey })
      .signers([oracleAuthority])
      .rpc();

    const finalizeAccounts = {
      config: configPda,
      basket: basketPda(basketId),
      oracleAuthority: oracleAuthority.publicKey,
    };

    try {
      await program.methods.finalizeSettlement().accounts(finalizeAccounts).signers([oracleAuthority]).rpc();
      assert.fail("finalize before the challenge window should fail");
    } catch (e) {
      assert.match((e as Error).toString(), /ChallengeWindowActive|custom program error/i);
    }

    try {
      await program.methods
        .claim()
        .accounts({
          config: configPda,
          basket: basketPda(basketId),
          vault: vaultPda(basketId),
          position: positionPda(basketId, user.publicKey),
          claimerUsdc: userUsdc,
          usdcMint: mint,
          claimer: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail("claim during the challenge window should fail");
    } catch (e) {
      assert.match((e as Error).toString(), /NotSettled|custom program error/i);
    }

    await finalizeWhenAllowed(basketId);

    const basketAcct = await (program.account as any).basket.fetch(basketPda(basketId));
    assert.equal(basketAcct.settlementIndexBps, 5000, "settlement promoted from proposed");
  });

  it("rejects finalize with no active proposal", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    try {
      await program.methods
        .finalizeSettlement()
        .accounts({ config: configPda, basket: basketPda(basketId), oracleAuthority: oracleAuthority.publicKey })
        .signers([oracleAuthority])
        .rpc();
      assert.fail("finalize without a proposal should fail");
    } catch (e) {
      assert.match((e as Error).toString(), /NoActiveProposal|custom program error/i);
    }
  });

  it("rejects an underfunded claim, and succeeds after funding", async () => {
    const basketId = newBasketId();
    await createBasket(basketId);
    await stakeTx({
      basketId,
      staker: user,
      stakerUsdc: userUsdc,
      amount: 100 * ONE_USDC,
      entryBps: 5000,
      nonce: 30n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 300),
    });
    await settle(basketId, 10000);

    const claimAccounts = {
      config: configPda,
      basket: basketPda(basketId),
      vault: vaultPda(basketId),
      position: positionPda(basketId, user.publicKey),
      claimerUsdc: userUsdc,
      usdcMint: mint,
      claimer: user.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
    try {
      await program.methods.claim().accounts(claimAccounts).signers([user]).rpc();
      assert.fail("underfunded claim should fail");
    } catch (e) {
      assert.match((e as Error).toString(), /InsufficientVaultLiquidity|custom program error/i);
    }

    const houseUsdc = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey)).address;
    await mintTo(connection, payer, mint, houseUsdc, payer, 100 * ONE_USDC);
    await program.methods
      .fundBasket(new BN(100 * ONE_USDC))
      .accounts({
        config: configPda,
        basket: basketPda(basketId),
        vault: vaultPda(basketId),
        funderUsdc: houseUsdc,
        usdcMint: mint,
        funder: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    await program.methods.claim().accounts(claimAccounts).signers([user]).rpc();

    try {
      await program.methods.claim().accounts(claimAccounts).signers([user]).rpc();
      assert.fail("double claim should fail");
    } catch (e) {
      assert.match((e as Error).toString(), /AlreadyClaimed|custom program error/i);
    }
  });
});
