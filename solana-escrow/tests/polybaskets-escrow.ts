import * as anchor from "@coral-xyz/anchor";
import { BN, BorshAccountsCoder, Program } from "@coral-xyz/anchor";
import { BankrunProvider } from "anchor-bankrun";
import { assert } from "chai";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  BanksClient,
  Clock,
  ProgramTestContext,
  startAnchor,
} from "solana-bankrun";
import {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { PolybasketsEscrow } from "../target/types/polybaskets_escrow";

const IDL = JSON.parse(readFileSync("target/idl/polybaskets_escrow.json", "utf8"));
const PROGRAM_ID = new PublicKey(IDL.address);
const ONE_USDC = 1_000_000;
const FAR_EXPIRY = 4_102_444_800;
const COMPOSITION_DOMAIN = Buffer.from("AB_CREATE_V2");
const PRICE_ATTESTATION_DOMAIN = Buffer.from("ALPHABASKET_SPOT_PRICE_V1");
const DEPOSIT_INTENT_DOMAIN = Buffer.from("ALPHABASKET_DEPOSIT_INTENT_V1");
const WITHDRAWAL_INTENT_DOMAIN = Buffer.from(
  "ALPHABASKET_WITHDRAWAL_INTENT_V1",
);
const MANAGEMENT_PERIOD_SECS = 30 * 24 * 60 * 60;
const bytes32 = () => Buffer.from(Keypair.generate().publicKey.toBytes());
const asArray = (value: Buffer) => [...value];
const asNumber = (value: BN) => Number(value.toString());

type BasketAsset = {
  marketId: string;
  kind:
    | { predictionMarket: { outcome: number; ctfTokenId: number[] } }
    | { spot: { tokenMint: PublicKey } };
  weightBps: number;
};
type EligibleMarket = {
  marketId: string;
  outcome: number;
  ctfTokenId: number[];
};

const predictionMarket = (
  marketId: string,
  outcome: number,
  weightBps: number,
  ctfByte: number,
): BasketAsset => ({
  marketId,
  kind: {
    predictionMarket: {
      outcome,
      ctfTokenId: asArray(Buffer.alloc(32, ctfByte)),
    },
  },
  weightBps,
});
const spot = (
  tokenMint: PublicKey,
  weightBps: number,
  marketId: string,
): BasketAsset => ({
  marketId,
  kind: { spot: { tokenMint } },
  weightBps,
});

const u16 = (value: number) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
};

const u32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};

const u64 = (value: bigint | number) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
};

const i64 = (value: bigint | number) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(BigInt(value));
  return bytes;
};

const canonicalComposition = (items: BasketAsset[]) =>
  Buffer.concat([
    u16(items.length),
    ...items.map((item) => {
      const market = Buffer.from(item.marketId);
      if ("predictionMarket" in item.kind) {
        const prediction = item.kind.predictionMarket;
        return Buffer.concat([
          u16(market.length),
          market,
          Buffer.from([0, prediction.outcome]),
          Buffer.from(prediction.ctfTokenId),
          u16(item.weightBps),
        ]);
      }
      return Buffer.concat([
        u16(market.length),
        market,
        Buffer.from([1]),
        item.kind.spot.tokenMint.toBuffer(),
        u16(item.weightBps),
      ]);
    }),
  ]);

const hashComposition = (items: BasketAsset[]) =>
  createHash("sha256").update(canonicalComposition(items)).digest();

const canonicalEligibility = (markets: EligibleMarket[]) =>
  Buffer.concat([
    u16(markets.length),
    ...markets.map((market) => {
      const marketId = Buffer.from(market.marketId);
      return Buffer.concat([
        u16(marketId.length),
        marketId,
        Buffer.from([market.outcome]),
        Buffer.from(market.ctfTokenId),
      ]);
    }),
  ]);

const hashEligibility = (markets: EligibleMarket[]) =>
  createHash("sha256").update(canonicalEligibility(markets)).digest();

const feeCeil = (value: number, bps: number) =>
  Math.floor((value * bps + 9_999) / 10_000);

const feeFloor = (value: number, bps: number) =>
  Math.floor((value * bps) / 10_000);

const minimumAfterSlippage = (value: number, bps: number) =>
  Number(
    (BigInt(value) * BigInt(10_000 - bps) + 9_999n) / 10_000n,
  );

const managementSharesForElapsed = (
  supply: bigint,
  elapsedSeconds: bigint,
  remainder: bigint,
) => {
  const denominator = 9_965n * BigInt(MANAGEMENT_PERIOD_SECS);
  const numerator = supply * 35n * elapsedSeconds + remainder;
  return {
    minted: numerator / denominator,
    remainder: numerator % denominator,
  };
};

describe("AlphaBasket v2 share accounting (bankrun)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let banksClient: BanksClient;
  let program: Program<PolybasketsEscrow>;
  let payer: Keypair;

  const composer = Keypair.generate();
  const backend = Keypair.generate();
  const admin = Keypair.generate();
  const user = Keypair.generate();
  const outsider = Keypair.generate();
  const creator = Keypair.generate().publicKey;
  const creatorFeeDestination = Keypair.generate().publicKey;
  const protocolTreasury = Keypair.generate().publicKey;
  const settlementMint = Keypair.generate().publicKey;
  let config: PublicKey;
  let compositionNonce = 0;
  let eligibilityNonce = 0;
  let settlementNonce = 0;

  const basketPda = (id: Buffer) =>
    PublicKey.findProgramAddressSync([Buffer.from("basket"), id], program.programId)[0];
  const positionPda = (basket: PublicKey, owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("position"), basket.toBuffer(), owner.toBuffer()],
      program.programId,
    )[0];
  const receiptPda = (hash: Buffer) =>
    PublicKey.findProgramAddressSync([Buffer.from("receipt"), hash], program.programId)[0];
  const validItems: BasketAsset[] = [
    predictionMarket("market-a", 1, 3_000, 1),
    predictionMarket("market-b", 0, 3_000, 2),
    predictionMarket("market-c", 1, 2_000, 3),
    predictionMarket("market-d", 0, 2_000, 4),
  ];
  const validEligibleMarkets: EligibleMarket[] = validItems.map((item) => {
    if (!("predictionMarket" in item.kind)) throw new Error("fixture must be prediction");
    return {
      marketId: item.marketId,
      outcome: item.kind.predictionMarket.outcome,
      ctfTokenId: item.kind.predictionMarket.ctfTokenId,
    };
  });

  const sendTx = (instructions: TransactionInstruction[], signers: Keypair[] = []) =>
    provider.sendAndConfirm!(new Transaction().add(...instructions), signers);

  async function expectRevert(
    instructions: TransactionInstruction[],
    signers: Keypair[],
    pattern: RegExp,
  ) {
    const salt = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: Math.floor(Math.random() * 1_000_000_000),
    });
    const tx = new Transaction().add(salt, ...instructions);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await banksClient.getLatestBlockhash())![0];
    tx.sign(payer, ...signers);
    const result = await banksClient.tryProcessTransaction(tx);
    assert.isNotNull(result.result, "expected transaction to fail");
    const logs = (result.meta?.logMessages ?? []).join("\n");
    assert.match(logs, pattern, "logs:\n" + logs);
  }

  const fundSol = (recipient: PublicKey) =>
    sendTx([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports: 5_000_000_000,
      }),
    ]);

  async function warpSeconds(seconds: number) {
    const clock = await banksClient.getClock();
    context.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        clock.unixTimestamp + BigInt(seconds),
      ),
    );
  }

  function compositionMessage(args: {
    basketId: Buffer;
    eligibilityHash: Buffer;
    eligibilityNonce: number;
    performanceFeeBps: number;
    isPerpetual: boolean;
    reconstitutionCadenceSecs: number;
    compositionNonce: number;
    compositionExpiry: number;
  }) {
    return Buffer.concat([
      COMPOSITION_DOMAIN,
      program.programId.toBuffer(),
      args.basketId,
      creator.toBuffer(),
      creatorFeeDestination.toBuffer(),
      args.eligibilityHash,
      u64(args.eligibilityNonce),
      u16(args.performanceFeeBps),
      Buffer.from([args.isPerpetual ? 1 : 0]),
      i64(args.reconstitutionCadenceSecs),
      u64(args.compositionNonce),
      i64(args.compositionExpiry),
    ]);
  }

  async function buildCreateBasket(
    basketId: Buffer,
    options: {
      items?: BasketAsset[];
      signatureKey?: Keypair;
      compositionHash?: Buffer;
      eligibleMarkets?: EligibleMarket[];
      performanceFeeBps?: number;
      isPerpetual?: boolean;
      reconstitutionCadenceSecs?: number;
      skipDraftSubmission?: boolean;
    } = {},
  ) {
    const items = options.items ?? validItems;
    const eligibleMarkets = options.eligibleMarkets ?? validEligibleMarkets;
    const listNonce = ++eligibilityNonce;
    const eligibilityHash = hashEligibility(eligibleMarkets);
    const [eligibilityList] = PublicKey.findProgramAddressSync(
      [Buffer.from("eligibility"), eligibilityHash, u64(listNonce)],
      program.programId,
    );
    const clock = await banksClient.getClock();
    await program.methods
      .publishEligibilityList({
        listHash: asArray(eligibilityHash),
        nonce: new BN(listNonce),
        expiresAt: new BN(clock.unixTimestamp + 600n),
        markets: eligibleMarkets,
      })
      .accountsStrict({
        config,
        eligibilityList,
        composerSigner: composer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([composer])
      .rpc();
    const args = {
      basketId,
      compositionHash: options.compositionHash ?? hashComposition(items),
      eligibilityHash,
      eligibilityNonce: listNonce,
      items,
      performanceFeeBps: options.performanceFeeBps ?? 1_000,
      isPerpetual: options.isPerpetual ?? false,
      reconstitutionCadenceSecs: options.reconstitutionCadenceSecs ?? 0,
      compositionNonce: ++compositionNonce,
      compositionExpiry: FAR_EXPIRY,
    };
    const [compositionDraft] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("composition_draft"),
        args.compositionHash,
        u64(args.compositionNonce),
      ],
      program.programId,
    );
    let draftBuilder = program.methods
      .publishCompositionDraft({
        compositionHash: asArray(args.compositionHash),
        eligibilityHash: asArray(args.eligibilityHash),
        eligibilityNonce: new BN(args.eligibilityNonce),
        compositionNonce: new BN(args.compositionNonce),
        items: args.items,
      })
      .accountsStrict({
        config,
        compositionDraft,
        eligibilityList,
        composerSigner: composer.publicKey,
        systemProgram: SystemProgram.programId,
      });
    const [tokenAllowlist] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_allowlist")],
      program.programId,
    );
    if (items.some((item) => "spot" in item.kind)) {
      draftBuilder = draftBuilder.remainingAccounts([
        { pubkey: tokenAllowlist, isSigner: false, isWritable: false },
      ]);
    }
    const draftIx = await draftBuilder.instruction();
    if (!options.skipDraftSubmission) {
      await sendTx([draftIx], [composer]);
    }
    const signatureIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: (options.signatureKey ?? composer).secretKey,
      message: compositionMessage(args),
    });
    let createBuilder = program.methods
      .createBasket({
        basketId: asArray(args.basketId),
        compositionHash: asArray(args.compositionHash),
        eligibilityHash: asArray(args.eligibilityHash),
        eligibilityNonce: new BN(args.eligibilityNonce),
        creator,
        creatorFeeDestination,
        performanceFeeBps:
          options.performanceFeeBps === undefined
            ? null
            : options.performanceFeeBps,
        isPerpetual: args.isPerpetual,
        reconstitutionCadenceSecs: new BN(args.reconstitutionCadenceSecs),
        compositionNonce: new BN(args.compositionNonce),
        compositionExpiry: new BN(args.compositionExpiry),
      })
      .accountsStrict({
        config,
        basket: basketPda(basketId),
        compositionDraft,
        eligibilityList,
        composerSigner: composer.publicKey,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      });
    if (items.some((item) => "spot" in item.kind)) {
      createBuilder = createBuilder.remainingAccounts([
        { pubkey: tokenAllowlist, isSigner: false, isWritable: false },
      ]);
    }
    const createIx = await createBuilder.instruction();
    return {
      signatureIx,
      createIx,
      draftIx,
      eligibilityList,
      compositionDraft,
    };
  }

  async function createBasket(
    basketId: Buffer,
    options: {
      items?: BasketAsset[];
      eligibleMarkets?: EligibleMarket[];
      performanceFeeBps?: number;
      isPerpetual?: boolean;
      reconstitutionCadenceSecs?: number;
    } = {},
  ): Promise<PublicKey> {
    const { signatureIx, createIx } = await buildCreateBasket(basketId, options);
    await sendTx([signatureIx, createIx], [composer]);
    return basketPda(basketId);
  }

  const tokenAllowlistPda = () =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("token_allowlist")],
      program.programId,
    )[0];

  async function registerSpotToken(
    tokenMint: PublicKey,
    enabled = true,
  ): Promise<void> {
    await program.methods
      .registerToken({
        tokenMint,
        jupiterVerified: true,
        assetClass: { crypto: {} },
        availability: { twentyFourSeven: {} },
        priceSource: { signedTwap: {} },
        backingAttestationHash: asArray(Buffer.alloc(32)),
        enabled,
      })
      .accountsStrict({
        config,
        tokenAllowlist: tokenAllowlistPda(),
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
  }

  async function deposit(args: {
    basket: PublicKey;
    grossAmount: number;
    basketNavValue: number;
    sharePrice: number;
    signatureKey?: Keypair;
    intentNonce?: number;
    intentExpiry?: number;
    minSharesOut?: number;
    netDepositValue?: number;
    executionVersion?: number;
    executedAt?: number;
    expectedError?: RegExp;
  }) {
    const position = positionPda(args.basket, user.publicKey);
    const storedPosition = await program.account.position
      .fetch(position)
      .catch(() => null);
    const intentNonce =
      args.intentNonce ?? (storedPosition ? asNumber(storedPosition.lastIntentNonce) + 1 : 1);
    const storedBasket = await program.account.basket.fetch(args.basket);
    const expectedCompositionVersion = storedBasket.compositionVersion;
    const protocolFee = feeCeil(args.grossAmount, 50);
    const quotedNetDepositValue = args.grossAmount - protocolFee;
    const netDepositValue = args.netDepositValue ?? quotedNetDepositValue;
    const sharesCredited = Math.floor(
      (netDepositValue * ONE_USDC) / args.sharePrice,
    );
    const minSharesOut = args.minSharesOut ?? sharesCredited;
    const intentExpiry = args.intentExpiry ?? FAR_EXPIRY;
    const quoteHash = bytes32();
    const executionBatchHash = bytes32();
    const executedAt =
      args.executedAt ?? Number((await banksClient.getClock()).unixTimestamp);
    const completeArgs = {
      user: user.publicKey,
      intentNonce: new BN(intentNonce),
      intentExpiry: new BN(intentExpiry),
      expectedCompositionVersion,
      grossAmount: new BN(args.grossAmount),
      minSharesOut: new BN(minSharesOut),
      quoteHash: asArray(quoteHash),
      executionVersion: args.executionVersion ?? 1,
      executionBatchHash: asArray(executionBatchHash),
      executedAt: new BN(executedAt),
      navReportHash: asArray(bytes32()),
      settlementNonce: new BN(++settlementNonce),
      basketNavValue: new BN(args.basketNavValue),
      sharePrice: new BN(args.sharePrice),
      netDepositValue: new BN(netDepositValue),
      sharesCredited: new BN(sharesCredited),
      protocolFee: new BN(protocolFee),
    };
    const intentMessage = Buffer.concat([
      DEPOSIT_INTENT_DOMAIN,
      program.programId.toBuffer(),
      args.basket.toBuffer(),
      user.publicKey.toBuffer(),
      u64(intentNonce),
      i64(intentExpiry),
      u32(expectedCompositionVersion),
      u64(args.grossAmount),
      u64(minSharesOut),
      quoteHash,
    ]);
    const signatureIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: (args.signatureKey ?? user).secretKey,
      message: intentMessage,
    });
    const completeIx = await program.methods
      .completeDeposit({
        ...completeArgs,
      })
      .accountsStrict({
        config,
        basket: args.basket,
        position,
        receipt: receiptPda(executionBatchHash),
        backendSigner: backend.publicKey,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    if (args.expectedError) {
      await expectRevert([signatureIx, completeIx], [backend], args.expectedError);
    } else {
      await sendTx([signatureIx, completeIx], [backend]);
    }

    return {
      position,
      receipt: receiptPda(executionBatchHash),
      executionBatchHash,
      executedAt,
      intentNonce,
      protocolFee,
      netDepositValue,
      sharesCredited,
    };
  }

  async function withdraw(args: {
    basket: PublicKey;
    shareAmount: number;
    basketNavValue: number;
    sharePrice: number;
    grossRealizedValue: number;
    protocolFee: number;
    creatorFee: number;
    userValueOut: number;
    destination?: PublicKey;
    signatureKey?: Keypair;
    intentNonce?: number;
    intentExpiry?: number;
    minValueOut?: number;
    executionVersion?: number;
    executedAt?: number;
    expectedError?: RegExp;
  }) {
    const position = positionPda(args.basket, user.publicKey);
    const storedPosition = await program.account.position.fetch(position);
    const intentNonce =
      args.intentNonce ?? asNumber(storedPosition.lastIntentNonce) + 1;
    const storedBasket = await program.account.basket.fetch(args.basket);
    const expectedCompositionVersion = storedBasket.compositionVersion;
    const intentExpiry = args.intentExpiry ?? FAR_EXPIRY;
    const destination = args.destination ?? user.publicKey;
    const minValueOut = args.minValueOut ?? args.userValueOut;
    const quoteHash = bytes32();
    const executionBatchHash = bytes32();
    const executedAt =
      args.executedAt ?? Number((await banksClient.getClock()).unixTimestamp);
    const completeArgs = {
      user: user.publicKey,
      intentNonce: new BN(intentNonce),
      intentExpiry: new BN(intentExpiry),
      expectedCompositionVersion,
      shareAmount: new BN(args.shareAmount),
      minValueOut: new BN(minValueOut),
      destination,
      quoteHash: asArray(quoteHash),
      executionVersion: args.executionVersion ?? 1,
      executionBatchHash: asArray(executionBatchHash),
      executedAt: new BN(executedAt),
      navReportHash: asArray(bytes32()),
      settlementNonce: new BN(++settlementNonce),
      basketNavValue: new BN(args.basketNavValue),
      sharePrice: new BN(args.sharePrice),
      grossRealizedValue: new BN(args.grossRealizedValue),
      protocolFee: new BN(args.protocolFee),
      creatorFee: new BN(args.creatorFee),
      userValueOut: new BN(args.userValueOut),
    };
    const intentMessage = Buffer.concat([
      WITHDRAWAL_INTENT_DOMAIN,
      program.programId.toBuffer(),
      args.basket.toBuffer(),
      user.publicKey.toBuffer(),
      u64(intentNonce),
      i64(intentExpiry),
      u32(expectedCompositionVersion),
      u64(args.shareAmount),
      u64(minValueOut),
      destination.toBuffer(),
      quoteHash,
    ]);
    const signatureIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: (args.signatureKey ?? user).secretKey,
      message: intentMessage,
    });
    const completeIx = await program.methods
      .completeWithdrawal({
        ...completeArgs,
      })
      .accountsStrict({
        config,
        basket: args.basket,
        position,
        receipt: receiptPda(executionBatchHash),
        backendSigner: backend.publicKey,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    if (args.expectedError) {
      await expectRevert([signatureIx, completeIx], [backend], args.expectedError);
    } else {
      await sendTx([signatureIx, completeIx], [backend]);
    }

    return {
      position,
      receipt: receiptPda(executionBatchHash),
      executionBatchHash,
      executedAt,
      intentNonce,
    };
  }

  async function withdrawProtocolFees(args: {
    basket: PublicKey;
    shareAmount: number;
    basketNavValue: number;
    sharePrice: number;
    grossRealizedValue: number;
    expectedError?: RegExp;
  }) {
    const executionBatchHash = bytes32();
    const executedAt = Number((await banksClient.getClock()).unixTimestamp);
    const completeIx = await program.methods
      .completeProtocolFeeWithdrawal({
        executionVersion: 1,
        executionBatchHash: asArray(executionBatchHash),
        executedAt: new BN(executedAt),
        navReportHash: asArray(bytes32()),
        settlementNonce: new BN(++settlementNonce),
        shareAmount: new BN(args.shareAmount),
        basketNavValue: new BN(args.basketNavValue),
        sharePrice: new BN(args.sharePrice),
        grossRealizedValue: new BN(args.grossRealizedValue),
      })
      .accountsStrict({
        config,
        basket: args.basket,
        receipt: receiptPda(executionBatchHash),
        backendSigner: backend.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    if (args.expectedError) {
      await expectRevert([completeIx], [backend], args.expectedError);
    } else {
      await sendTx([completeIx], [backend]);
    }
    return {
      receipt: receiptPda(executionBatchHash),
      executionBatchHash,
    };
  }

  before(async () => {
    const [configAddress, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      PROGRAM_ID,
    );
    config = configAddress;
    const encodedConfig = await new BorshAccountsCoder(IDL as anchor.Idl).encode(
      "Config",
      {
        admin: admin.publicKey,
        pending_admin: null,
        composer_signer: composer.publicKey,
        backend_signer: backend.publicKey,
        protocol_treasury: protocolTreasury,
        settlement_mint: settlementMint,
        max_slippage_bps: 1_000,
        accounting_decimals: 6,
        paused: false,
        bump: configBump,
      },
    );
    // Leave room for pending_admin to transition from None to Some(pubkey).
    // Bankrun preloads raw account data and does not perform Anchor reallocs.
    const configData = Buffer.alloc(256);
    encodedConfig.copy(configData);
    // Bankrun loads test programs under the legacy loader, while production
    // initialization now requires the upgradeable ProgramData authority.
    context = await startAnchor("", [], [
      {
        address: config,
        info: {
          lamports: 10_000_000,
          data: configData,
          owner: PROGRAM_ID,
          executable: false,
          rentEpoch: 0,
        },
      },
    ]);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    banksClient = context.banksClient;
    program = new Program<PolybasketsEscrow>(IDL as anchor.Idl, provider);
    payer = (provider.wallet as anchor.Wallet).payer;
    assert.isTrue(program.programId.equals(PROGRAM_ID));
    await fundSol(admin.publicKey);
    await fundSol(composer.publicKey);
    await fundSol(backend.publicKey);
    await fundSol(user.publicKey);
    await fundSol(outsider.publicKey);

  });

  it("requires the proposed admin to accept authority", async () => {
    const nextAdmin = Keypair.generate();
    await fundSol(nextAdmin.publicKey);
    await program.methods
      .proposeAdmin(nextAdmin.publicKey)
      .accountsStrict({ config, admin: admin.publicKey })
      .signers([admin])
      .rpc();

    const unauthorizedAccept = await program.methods
      .acceptAdmin()
      .accountsStrict({ config, pendingAdmin: outsider.publicKey })
      .instruction();
    await expectRevert(
      [unauthorizedAccept],
      [outsider],
      /AdminTransferNotPending/,
    );

    await program.methods
      .acceptAdmin()
      .accountsStrict({ config, pendingAdmin: nextAdmin.publicKey })
      .signers([nextAdmin])
      .rpc();
    let stored = await program.account.config.fetch(config);
    assert.isTrue(stored.admin.equals(nextAdmin.publicKey));
    assert.isNull(stored.pendingAdmin);

    await program.methods
      .proposeAdmin(admin.publicKey)
      .accountsStrict({ config, admin: nextAdmin.publicKey })
      .signers([nextAdmin])
      .rpc();
    await program.methods
      .acceptAdmin()
      .accountsStrict({ config, pendingAdmin: admin.publicKey })
      .signers([admin])
      .rpc();
    stored = await program.account.config.fetch(config);
    assert.isTrue(stored.admin.equals(admin.publicKey));
  });

  it("verifies Composer authorization, composition rules, and the 20% creator-fee cap", async () => {
    const unauthorized = await buildCreateBasket(bytes32(), {
      signatureKey: outsider,
    });
    await expectRevert(
      [unauthorized.signatureIx, unauthorized.createIx],
      [composer],
      /UnauthorizedCompositionSigner/,
    );

    const overweightItems: BasketAsset[] = [
      predictionMarket("market-a", 1, 3_001, 1),
      predictionMarket("market-b", 0, 2_999, 2),
      predictionMarket("market-c", 1, 2_000, 3),
      predictionMarket("market-d", 0, 2_000, 4),
    ];
    const overweight = await buildCreateBasket(bytes32(), {
      items: overweightItems,
      skipDraftSubmission: true,
    });
    await expectRevert(
      [overweight.draftIx],
      [composer],
      /MarketWeightExceeded/,
    );

    const duplicateCtfItems: BasketAsset[] = [
      predictionMarket("market-a", 1, 3_000, 1),
      predictionMarket("market-b", 0, 3_000, 1),
      predictionMarket("market-c", 1, 2_000, 3),
      predictionMarket("market-d", 0, 2_000, 4),
    ];
    const duplicateCtf = await buildCreateBasket(bytes32(), {
      items: duplicateCtfItems,
      skipDraftSubmission: true,
    });
    await expectRevert(
      [duplicateCtf.draftIx],
      [composer],
      /InvalidBasketItems/,
    );

    const excessiveFee = await buildCreateBasket(bytes32(), {
      performanceFeeBps: 2_001,
    });
    await expectRevert(
      [excessiveFee.signatureIx, excessiveFee.createIx],
      [composer],
      /InvalidBasisPoints/,
    );

    const basket = await createBasket(bytes32());
    const stored = await program.account.basket.fetch(basket);
    assert.equal(stored.performanceFeeBps, 1_000);
    assert.isTrue(stored.protocolFeeDestination.equals(protocolTreasury));
    assert.equal(stored.items.reduce((sum, item) => sum + item.weightBps, 0), 10_000);

    const zeroFeeBasket = await createBasket(bytes32(), { performanceFeeBps: 0 });
    const zeroFeeStored = await program.account.basket.fetch(zeroFeeBasket);
    assert.equal(zeroFeeStored.performanceFeeBps, 0);
  });

  it("enforces the spot allowlist and 30%/20% source-aware caps", async () => {
    const spotMints = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
    for (const mint of spotMints) await registerSpotToken(mint);

    const spotItems = [
      spot(spotMints[0]!, 3_000, "spot-a"),
      spot(spotMints[1]!, 3_000, "spot-b"),
      spot(spotMints[2]!, 2_000, "spot-c"),
      spot(spotMints[3]!, 2_000, "spot-d"),
    ];
    const spotBasket = await createBasket(bytes32(), {
      items: spotItems,
      eligibleMarkets: [],
    });
    const storedSpot = await program.account.basket.fetch(spotBasket);
    assert.equal(storedSpot.items.length, 4);
    assert.isTrue("spot" in storedSpot.items[0]!.kind);

    const mixedItems = [
      predictionMarket("mixed-market-a", 1, 2_000, 11),
      predictionMarket("mixed-market-b", 0, 2_000, 12),
      spot(spotMints[0]!, 2_000, "mixed-spot-a"),
      spot(spotMints[1]!, 2_000, "mixed-spot-b"),
      spot(spotMints[2]!, 2_000, "mixed-spot-c"),
    ];
    const mixedEligible: EligibleMarket[] = mixedItems
      .filter((item) => "predictionMarket" in item.kind)
      .map((item) => {
        if (!("predictionMarket" in item.kind)) throw new Error("fixture mismatch");
        return {
          marketId: item.marketId,
          outcome: item.kind.predictionMarket.outcome,
          ctfTokenId: item.kind.predictionMarket.ctfTokenId,
        };
      });
    const mixedBasket = await createBasket(bytes32(), {
      items: mixedItems,
      eligibleMarkets: mixedEligible,
    });
    const storedMixed = await program.account.basket.fetch(mixedBasket);
    assert.equal(storedMixed.items.length, 5);

    const overweightMixed = [
      { ...mixedItems[0]!, weightBps: 2_001 },
      mixedItems[1]!,
      mixedItems[2]!,
      mixedItems[3]!,
      { ...mixedItems[4]!, weightBps: 1_999 },
    ];
    const overweight = await buildCreateBasket(bytes32(), {
      items: overweightMixed,
      eligibleMarkets: mixedEligible,
      skipDraftSubmission: true,
    });
    await expectRevert(
      [overweight.draftIx],
      [composer],
      /MarketWeightExceeded/,
    );

    await registerSpotToken(spotMints[0]!, false);
    const disabled = await buildCreateBasket(bytes32(), {
      items: spotItems,
      eligibleMarkets: [],
      skipDraftSubmission: true,
    });
    await expectRevert(
      [disabled.draftIx],
      [composer],
      /TokenNotAllowlisted/,
    );
    // Disabling is prospective only; it does not mutate an existing basket.
    assert.equal((await program.account.basket.fetch(spotBasket)).items.length, 4);
  });

  it("stores only fresh Composer-signed TWAP fallback prices and rejects replay", async () => {
    const tokenMint = Keypair.generate().publicKey;
    await registerSpotToken(tokenMint);
    const [priceAttestation] = PublicKey.findProgramAddressSync(
      [Buffer.from("price_attestation"), tokenMint.toBuffer()],
      program.programId,
    );
    const observedAt = Number((await banksClient.getClock()).unixTimestamp);
    const priceArgs = {
      tokenMint,
      priceValue: new BN(12_345_678),
      confidenceBps: 75,
      observedAt: new BN(observedAt),
      validUntil: new BN(observedAt + 120),
      nonce: new BN(1),
    };
    const message = Buffer.concat([
      PRICE_ATTESTATION_DOMAIN,
      program.programId.toBuffer(),
      tokenMint.toBuffer(),
      u64(12_345_678),
      u16(75),
      i64(observedAt),
      i64(observedAt + 120),
      u64(1),
    ]);
    const verifyIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: composer.secretKey,
      message,
    });
    const submitIx = await program.methods
      .submitPriceAttestation(priceArgs)
      .accountsStrict({
        config,
        tokenAllowlist: tokenAllowlistPda(),
        priceAttestation,
        composerSigner: composer.publicKey,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    await sendTx([verifyIx, submitIx], [composer]);
    const stored = await program.account.priceAttestation.fetch(priceAttestation);
    assert.equal(asNumber(stored.priceValue), 12_345_678);
    assert.equal(stored.confidenceBps, 75);

    await expectRevert(
      [verifyIx, submitIx],
      [composer],
      /PriceAttestationNonceNotIncreasing/,
    );
  });

  it("rejects replayed composition nonces during reconstitution", async () => {
    const basket = await createBasket(bytes32(), {
      isPerpetual: true,
      reconstitutionCadenceSecs: 1,
    });
    await warpSeconds(2);
    await program.methods
      .beginReconstitution()
      .accountsStrict({ config, basket, backendSigner: backend.publicKey })
      .signers([backend])
      .rpc();

    const stored = await program.account.basket.fetch(basket);
    const eligibilityHash = hashEligibility(validEligibleMarkets);
    const [eligibilityList] = PublicKey.findProgramAddressSync(
      [Buffer.from("eligibility"), eligibilityHash, u64(eligibilityNonce)],
      program.programId,
    );
    const compositionHash = hashComposition(validItems);
    const [compositionDraft] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("composition_draft"),
        compositionHash,
        u64(asNumber(stored.lastCompositionNonce)),
      ],
      program.programId,
    );
    const replay = await program.methods
      .completeReconstitution({
        compositionHash: asArray(compositionHash),
        eligibilityHash: asArray(eligibilityHash),
        eligibilityNonce: new BN(eligibilityNonce),
        compositionNonce: stored.lastCompositionNonce,
        compositionExpiry: new BN(FAR_EXPIRY),
      })
      .accountsStrict({
        config,
        basket,
        compositionDraft,
        eligibilityList,
        backendSigner: backend.publicKey,
        composerSigner: composer.publicKey,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    await expectRevert(
      [replay],
      [backend, composer],
      /CompositionNonceNotIncreasing/,
    );
  });

  it("uses $1 only for initialization, then mints at NAV divided by total shares", async () => {
    const basket = await createBasket(bytes32());
    const first = await deposit({
      basket,
      grossAmount: 100 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });
    assert.equal(first.protocolFee, 500_000);
    assert.equal(first.netDepositValue, 99_500_000);
    assert.equal(first.sharesCredited, 99_500_000);

    const second = await deposit({
      basket,
      grossAmount: 100 * ONE_USDC,
      basketNavValue: 199 * ONE_USDC,
      sharePrice: 2 * ONE_USDC,
    });
    assert.equal(second.protocolFee, 500_000);
    assert.equal(second.sharesCredited, 49_750_000);

    const storedBasket = await program.account.basket.fetch(basket);
    const storedPosition = await program.account.position.fetch(first.position);
    const secondReceipt = await program.account.settlementReceipt.fetch(second.receipt);
    assert.equal(asNumber(storedBasket.totalSharesOutstanding), 149_250_000);
    assert.equal(asNumber(storedPosition.sharesOwned), 149_250_000);
    assert.isAbove(asNumber(storedPosition.weightedDepositTimestamp), 0);
    assert.equal(storedPosition.reserved.length, 64);
    assert.equal(asNumber(secondReceipt.sharePrice), 2 * ONE_USDC);
  });

  it("mints from actual deposit credit while enforcing the protocol slippage floor", async () => {
    const basket = await createBasket(bytes32());
    const grossAmount = 100 * ONE_USDC;
    const quotedNet = grossAmount - feeCeil(grossAmount, 50);
    const minimumNet = minimumAfterSlippage(quotedNet, 1_000);

    await deposit({
      basket,
      grossAmount,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
      netDepositValue: quotedNet + 1,
      expectedError: /InvalidSettlementValues/,
    });
    await deposit({
      basket,
      grossAmount,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
      netDepositValue: minimumNet - 1,
      expectedError: /SlippageExceeded/,
    });
    await deposit({
      basket,
      grossAmount,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
      netDepositValue: minimumNet,
      minSharesOut: minimumNet + 1,
      expectedError: /SlippageExceeded/,
    });

    const completed = await deposit({
      basket,
      grossAmount,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
      netDepositValue: minimumNet,
    });
    const storedBasket = await program.account.basket.fetch(basket);
    const storedPosition = await program.account.position.fetch(completed.position);
    const receipt = await program.account.settlementReceipt.fetch(completed.receipt);

    assert.equal(completed.sharesCredited, minimumNet);
    assert.equal(asNumber(storedBasket.totalSharesOutstanding), minimumNet);
    assert.equal(asNumber(storedPosition.costBasisValue), minimumNet);
    assert.equal(asNumber(receipt.grossValue), minimumNet);
    assert.equal(asNumber(receipt.protocolFee), feeCeil(grossAmount, 50));
  });

  it("allows deposits above the former user and basket caps", async () => {
    const basket = await createBasket(bytes32());
    const grossAmount = 10_001 * ONE_USDC;
    const completed = await deposit({
      basket,
      grossAmount,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });

    const storedBasket = await program.account.basket.fetch(basket);
    const storedPosition = await program.account.position.fetch(completed.position);
    assert.equal(asNumber(storedBasket.grossDepositedValue), grossAmount);
    assert.equal(asNumber(storedPosition.grossDepositedValue), grossAmount);
  });

  it("requires the user's signature and rejects replayed intent nonces", async () => {
    const basket = await createBasket(bytes32());
    await deposit({
      basket,
      grossAmount: 10 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
      signatureKey: outsider,
      expectedError: /UnauthorizedIntentSigner/,
    });

    const first = await deposit({
      basket,
      grossAmount: 10 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });
    await deposit({
      basket,
      grossAmount: 10 * ONE_USDC,
      basketNavValue: first.netDepositValue,
      sharePrice: ONE_USDC,
      intentNonce: first.intentNonce,
      expectedError: /IntentNonceMismatch/,
    });

    const storedPosition = await program.account.position.fetch(first.position);
    assert.equal(asNumber(storedPosition.lastIntentNonce), first.intentNonce);
    assert.equal(asNumber(storedPosition.sharesOwned), first.sharesCredited);
  });

  it("accrues 0.35% monthly by dilution and lets the backend redeem protocol shares", async () => {
    const basket = await createBasket(bytes32());
    const first = await deposit({
      basket,
      grossAmount: 100 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });
    await warpSeconds(3 * MANAGEMENT_PERIOD_SECS);

    await program.methods
      .accrueManagementFee()
      .accountsStrict({ config, basket })
      .rpc();

    let expectedSupply = BigInt(first.sharesCredited);
    let expectedProtocolShares = 0n;
    let remainder = 0n;
    for (let period = 0; period < 3; period += 1) {
      const accrued = managementSharesForElapsed(
        expectedSupply,
        BigInt(MANAGEMENT_PERIOD_SECS),
        remainder,
      );
      expectedSupply += accrued.minted;
      expectedProtocolShares += accrued.minted;
      remainder = accrued.remainder;
    }
    let storedBasket = await program.account.basket.fetch(basket);
    assert.equal(
      storedBasket.protocolFeeShares.toString(),
      expectedProtocolShares.toString(),
    );
    assert.equal(
      storedBasket.totalSharesOutstanding.toString(),
      expectedSupply.toString(),
    );

    const executionBatchHash = bytes32();
    const executedAt = Number((await banksClient.getClock()).unixTimestamp);
    await program.methods
      .completeProtocolFeeWithdrawal({
        executionVersion: 1,
        executionBatchHash: asArray(executionBatchHash),
        executedAt: new BN(executedAt),
        navReportHash: asArray(bytes32()),
        settlementNonce: new BN(++settlementNonce),
        shareAmount: new BN(expectedProtocolShares.toString()),
        basketNavValue: new BN(expectedSupply.toString()),
        sharePrice: new BN(ONE_USDC),
        grossRealizedValue: new BN(expectedProtocolShares.toString()),
      })
      .accountsStrict({
        config,
        basket,
        receipt: receiptPda(executionBatchHash),
        backendSigner: backend.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([backend])
      .rpc();

    storedBasket = await program.account.basket.fetch(basket);
    const receipt = await program.account.settlementReceipt.fetch(
      receiptPda(executionBatchHash),
    );
    assert.equal(asNumber(storedBasket.protocolFeeShares), 0);
    assert.equal(
      storedBasket.totalSharesOutstanding.toString(),
      BigInt(first.sharesCredited).toString(),
    );
    assert.isTrue(receipt.user.equals(protocolTreasury));
    assert.equal(receipt.userValueOut.toString(), expectedProtocolShares.toString());
  });

  it("bounds protocol-share execution and blocks it while paused", async () => {
    const basket = await createBasket(bytes32());
    await deposit({
      basket,
      grossAmount: 100 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });
    await warpSeconds(MANAGEMENT_PERIOD_SECS);
    await program.methods
      .accrueManagementFee()
      .accountsStrict({ config, basket })
      .rpc();

    const before = await program.account.basket.fetch(basket);
    const shareAmount = asNumber(before.protocolFeeShares);
    const basketNavValue = asNumber(before.totalSharesOutstanding);
    const minimumGross = minimumAfterSlippage(shareAmount, 1_000);

    await program.methods
      .setPaused(true)
      .accountsStrict({ config, admin: admin.publicKey })
      .signers([admin])
      .rpc();
    let pausedAttempt: Awaited<ReturnType<typeof withdrawProtocolFees>>;
    try {
      pausedAttempt = await withdrawProtocolFees({
        basket,
        shareAmount,
        basketNavValue,
        sharePrice: ONE_USDC,
        grossRealizedValue: shareAmount,
        expectedError: /Paused/,
      });
    } finally {
      await program.methods
        .setPaused(false)
        .accountsStrict({ config, admin: admin.publicKey })
        .signers([admin])
        .rpc();
    }

    const afterPause = await program.account.basket.fetch(basket);
    const pausedReceipt = await program.account.settlementReceipt
      .fetch(pausedAttempt.receipt)
      .catch(() => null);
    assert.equal(
      afterPause.totalSharesOutstanding.toString(),
      before.totalSharesOutstanding.toString(),
    );
    assert.equal(
      afterPause.protocolFeeShares.toString(),
      before.protocolFeeShares.toString(),
    );
    assert.equal(
      afterPause.lastSettlementNonce.toString(),
      before.lastSettlementNonce.toString(),
    );
    assert.isNull(pausedReceipt);

    const belowAttempt = await withdrawProtocolFees({
      basket,
      shareAmount,
      basketNavValue,
      sharePrice: ONE_USDC,
      grossRealizedValue: minimumGross - 1,
      expectedError: /SlippageExceeded/,
    });
    const afterBelow = await program.account.basket.fetch(basket);
    const belowReceipt = await program.account.settlementReceipt
      .fetch(belowAttempt.receipt)
      .catch(() => null);
    assert.equal(
      afterBelow.totalSharesOutstanding.toString(),
      before.totalSharesOutstanding.toString(),
    );
    assert.equal(
      afterBelow.protocolFeeShares.toString(),
      before.protocolFeeShares.toString(),
    );
    assert.isNull(belowReceipt);

    const completed = await withdrawProtocolFees({
      basket,
      shareAmount,
      basketNavValue,
      sharePrice: ONE_USDC,
      grossRealizedValue: minimumGross,
    });
    const after = await program.account.basket.fetch(basket);
    const receipt = await program.account.settlementReceipt.fetch(completed.receipt);
    assert.equal(asNumber(after.protocolFeeShares), 0);
    assert.equal(
      after.totalSharesOutstanding.toString(),
      (BigInt(basketNavValue) - BigInt(shareAmount)).toString(),
    );
    assert.equal(asNumber(receipt.grossValue), minimumGross);
    assert.equal(asNumber(receipt.userValueOut), minimumGross);
  });

  it("accrues a 45-day interval exactly before pricing a new deposit", async () => {
    const basket = await createBasket(bytes32());
    const first = await deposit({
      basket,
      grossAmount: 100 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });
    const before = await program.account.basket.fetch(basket);
    await warpSeconds(MANAGEMENT_PERIOD_SECS + MANAGEMENT_PERIOD_SECS / 2);

    let expectedSupply = BigInt(first.sharesCredited);
    let remainder = 0n;
    const fullMonth = managementSharesForElapsed(
      expectedSupply,
      BigInt(MANAGEMENT_PERIOD_SECS),
      remainder,
    );
    expectedSupply += fullMonth.minted;
    remainder = fullMonth.remainder;
    const halfMonth = managementSharesForElapsed(
      expectedSupply,
      BigInt(MANAGEMENT_PERIOD_SECS / 2),
      remainder,
    );
    expectedSupply += halfMonth.minted;

    const second = await deposit({
      basket,
      grossAmount: 100 * ONE_USDC,
      basketNavValue: Number(expectedSupply),
      sharePrice: ONE_USDC,
    });
    const after = await program.account.basket.fetch(basket);
    assert.equal(
      asNumber(after.lastManagementFeeAt) - asNumber(before.lastManagementFeeAt),
      MANAGEMENT_PERIOD_SECS + MANAGEMENT_PERIOD_SECS / 2,
    );
    assert.equal(
      after.totalSharesOutstanding.toString(),
      (expectedSupply + BigInt(second.sharesCredited)).toString(),
    );
    assert.equal(
      after.managementFeeAccrualRemainder.toString(),
      halfMonth.remainder.toString(),
    );
  });

  it("stores the versioned execution batch atomically in the deposit receipt", async () => {
    const basket = await createBasket(bytes32());
    const completed = await deposit({
      basket,
      grossAmount: 100 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });

    const receipt = await program.account.settlementReceipt.fetch(completed.receipt);
    assert.equal(receipt.executionVersion, 1);
    assert.deepEqual(
      [...receipt.executionBatchHash],
      [...completed.executionBatchHash],
    );
    assert.equal(asNumber(receipt.executedAt), completed.executedAt);

    await deposit({
      basket,
      grossAmount: ONE_USDC,
      basketNavValue: completed.sharesCredited,
      sharePrice: ONE_USDC,
      executionVersion: 2,
      expectedError: /InvalidExecutionVersion/,
    });
  });

  it("charges 2% early withdrawal plus creator performance fee only on profit", async () => {
    const basket = await createBasket(bytes32());
    const entry = await deposit({
      basket,
      grossAmount: 100 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });
    const gross = 199 * ONE_USDC;
    const profit = gross - entry.netDepositValue;
    const creatorFee = feeFloor(profit, 1_000);
    const protocolFee = feeCeil(gross, 200);
    const userValueOut = gross - creatorFee - protocolFee;
    const exit = await withdraw({
      basket,
      shareAmount: entry.sharesCredited,
      basketNavValue: gross,
      sharePrice: 2 * ONE_USDC,
      grossRealizedValue: gross,
      protocolFee,
      creatorFee,
      userValueOut,
    });

    const receipt = await program.account.settlementReceipt.fetch(exit.receipt);
    const storedPosition = await program.account.position.fetch(exit.position);
    assert.equal(asNumber(receipt.withdrawnCostBasis), 99_500_000);
    assert.equal(asNumber(receipt.realizedProfit), 99_500_000);
    assert.equal(asNumber(receipt.creatorFee), 9_950_000);
    assert.equal(asNumber(receipt.protocolFee), 3_980_000);
    assert.equal(asNumber(receipt.earlyExitValue), 199_000_000);
    assert.equal(asNumber(receipt.matureExitValue), 0);
    assert.equal(asNumber(receipt.userValueOut), 185_070_000);
    assert.equal(asNumber(storedPosition.sharesOwned), 0);
    const storedBasket = await program.account.basket.fetch(basket);
    assert.deepEqual(storedBasket.status, { closed: {} });

    await deposit({
      basket,
      grossAmount: 10 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
      expectedError: /InvalidBasketStatus/,
    });
  });

  it("uses actual withdrawal proceeds and enforces both protocol and user minimums", async () => {
    const basket = await createBasket(bytes32());
    const entry = await deposit({
      basket,
      grossAmount: 100 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });
    const quotedGross = entry.sharesCredited;
    const minimumGross = minimumAfterSlippage(quotedGross, 1_000);
    const belowMinimum = minimumGross - 1;
    const belowFee = feeCeil(belowMinimum, 200);

    await withdraw({
      basket,
      shareAmount: entry.sharesCredited,
      basketNavValue: quotedGross,
      sharePrice: ONE_USDC,
      grossRealizedValue: belowMinimum,
      protocolFee: belowFee,
      creatorFee: 0,
      userValueOut: belowMinimum - belowFee,
      minValueOut: 0,
      expectedError: /SlippageExceeded/,
    });

    const protocolFee = feeCeil(minimumGross, 200);
    const userValueOut = minimumGross - protocolFee;
    await withdraw({
      basket,
      shareAmount: entry.sharesCredited,
      basketNavValue: quotedGross,
      sharePrice: ONE_USDC,
      grossRealizedValue: minimumGross,
      protocolFee,
      creatorFee: 0,
      userValueOut,
      minValueOut: userValueOut + 1,
      expectedError: /SlippageExceeded/,
    });

    const before = await program.account.position.fetch(entry.position);
    assert.equal(asNumber(before.sharesOwned), entry.sharesCredited);
    assert.equal(asNumber(before.costBasisValue), entry.netDepositValue);

    const exit = await withdraw({
      basket,
      shareAmount: entry.sharesCredited,
      basketNavValue: quotedGross,
      sharePrice: ONE_USDC,
      grossRealizedValue: minimumGross,
      protocolFee,
      creatorFee: 0,
      userValueOut,
    });
    const receipt = await program.account.settlementReceipt.fetch(exit.receipt);
    assert.equal(asNumber(receipt.grossValue), minimumGross);
    assert.equal(asNumber(receipt.protocolFee), protocolFee);
    assert.equal(asNumber(receipt.creatorFee), 0);
    assert.equal(asNumber(receipt.realizedProfit), 0);
    assert.equal(asNumber(receipt.userValueOut), userValueOut);
  });

  it("passes positive withdrawal execution improvement through to the user", async () => {
    const basket = await createBasket(bytes32());
    const entry = await deposit({
      basket,
      grossAmount: 100 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });
    const actualGross = 110 * ONE_USDC;
    const creatorFee = feeFloor(actualGross - entry.netDepositValue, 1_000);
    const protocolFee = feeCeil(actualGross, 200);
    const userValueOut = actualGross - creatorFee - protocolFee;
    const exit = await withdraw({
      basket,
      shareAmount: entry.sharesCredited,
      basketNavValue: entry.sharesCredited,
      sharePrice: ONE_USDC,
      grossRealizedValue: actualGross,
      protocolFee,
      creatorFee,
      userValueOut,
    });

    const receipt = await program.account.settlementReceipt.fetch(exit.receipt);
    assert.equal(asNumber(receipt.grossValue), actualGross);
    assert.equal(asNumber(receipt.creatorFee), creatorFee);
    assert.equal(asNumber(receipt.protocolFee), protocolFee);
    assert.equal(asNumber(receipt.userValueOut), userValueOut);
  });

  it("crystallizes performance fees only on redeemed shares and preserves remaining HWM basis", async () => {
    const basket = await createBasket(bytes32());
    const entry = await deposit({
      basket,
      grossAmount: 100 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });
    const halfShares = entry.sharesCredited / 2;

    const firstGross = Math.floor((halfShares * 1_500_000) / ONE_USDC);
    const firstBasis = entry.netDepositValue / 2;
    const firstCreatorFee = feeFloor(firstGross - firstBasis, 1_000);
    const firstProtocolFee = feeCeil(firstGross, 200);
    const firstExit = await withdraw({
      basket,
      shareAmount: halfShares,
      basketNavValue: entry.sharesCredited * 1.5,
      sharePrice: 1_500_000,
      grossRealizedValue: firstGross,
      protocolFee: firstProtocolFee,
      creatorFee: firstCreatorFee,
      userValueOut: firstGross - firstProtocolFee - firstCreatorFee,
    });

    const firstReceipt = await program.account.settlementReceipt.fetch(
      firstExit.receipt,
    );
    const remaining = await program.account.position.fetch(firstExit.position);
    assert.equal(asNumber(firstReceipt.withdrawnCostBasis), firstBasis);
    assert.equal(asNumber(firstReceipt.creatorFee), firstCreatorFee);
    assert.equal(asNumber(remaining.sharesOwned), halfShares);
    assert.equal(asNumber(remaining.costBasisValue), firstBasis);

    const secondGross = Math.floor((halfShares * 1_800_000) / ONE_USDC);
    const secondCreatorFee = feeFloor(secondGross - firstBasis, 1_000);
    const secondProtocolFee = feeCeil(secondGross, 200);
    const secondExit = await withdraw({
      basket,
      shareAmount: halfShares,
      basketNavValue: secondGross,
      sharePrice: 1_800_000,
      grossRealizedValue: secondGross,
      protocolFee: secondProtocolFee,
      creatorFee: secondCreatorFee,
      userValueOut: secondGross - secondProtocolFee - secondCreatorFee,
    });

    const secondReceipt = await program.account.settlementReceipt.fetch(
      secondExit.receipt,
    );
    assert.equal(asNumber(secondReceipt.withdrawnCostBasis), firstBasis);
    assert.equal(asNumber(secondReceipt.creatorFee), secondCreatorFee);
    assert.equal(
      firstCreatorFee + secondCreatorFee,
      feeFloor(firstGross + secondGross - entry.netDepositValue, 1_000),
    );
  });

  it("uses a cost-basis-weighted holding timestamp for the withdrawal tier", async () => {
    const basket = await createBasket(bytes32());
    await deposit({
      basket,
      grossAmount: 50 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });
    await warpSeconds(2 * MANAGEMENT_PERIOD_SECS + 24 * 60 * 60);
    await program.methods
      .accrueManagementFee()
      .accountsStrict({ config, basket })
      .rpc();

    const beforeSecond = await program.account.basket.fetch(basket);
    const navAtOneDollar = asNumber(beforeSecond.totalSharesOutstanding);
    await deposit({
      basket,
      grossAmount: 50 * ONE_USDC,
      basketNavValue: navAtOneDollar,
      sharePrice: ONE_USDC,
    });

    const userShares = 99_500_000;
    const protocolFee = feeCeil(userShares, 200);
    const userValueOut = userShares - protocolFee;
    const beforeExit = await program.account.basket.fetch(basket);
    const exit = await withdraw({
      basket,
      shareAmount: userShares,
      basketNavValue: asNumber(beforeExit.totalSharesOutstanding),
      sharePrice: ONE_USDC,
      grossRealizedValue: userShares,
      protocolFee,
      creatorFee: 0,
      userValueOut,
    });

    const receipt = await program.account.settlementReceipt.fetch(exit.receipt);
    assert.equal(asNumber(receipt.matureExitValue), 0);
    assert.equal(asNumber(receipt.earlyExitValue), userShares);
    assert.equal(asNumber(receipt.protocolFee), 1_990_000);
    assert.equal(asNumber(receipt.creatorFee), 0);
    assert.equal(asNumber(receipt.userValueOut), 97_510_000);
  });

  it("applies the same fee rules to final redemption and closes an exhausted basket", async () => {
    const basket = await createBasket(bytes32());
    const entry = await deposit({
      basket,
      grossAmount: 100 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });
    await program.methods
      .beginResolution()
      .accountsStrict({ config, basket, backendSigner: backend.publicKey })
      .signers([backend])
      .rpc();

    const finalNavValue = 120 * ONE_USDC;
    await program.methods
      .recordFinalSettlement({
        finalReportHash: asArray(bytes32()),
        finalNavValue: new BN(finalNavValue),
        finalShareSnapshot: new BN(entry.sharesCredited),
      })
      .accountsStrict({ config, basket, backendSigner: backend.publicKey })
      .signers([backend])
      .rpc();
    await warpSeconds(3 * MANAGEMENT_PERIOD_SECS + 1);

    const creatorFee = feeFloor(
      finalNavValue - entry.netDepositValue,
      1_000,
    );
    const protocolFee = feeCeil(finalNavValue, 100);
    const userValueOut = finalNavValue - creatorFee - protocolFee;
    const finalSharePrice = Math.floor(
      (finalNavValue * ONE_USDC) / entry.sharesCredited,
    );
    const mismatchedGross = finalNavValue - 1;
    const mismatchedCreatorFee = feeFloor(
      mismatchedGross - entry.netDepositValue,
      1_000,
    );
    const mismatchedProtocolFee = feeCeil(mismatchedGross, 100);
    await withdraw({
      basket,
      shareAmount: entry.sharesCredited,
      basketNavValue: finalNavValue,
      sharePrice: finalSharePrice,
      grossRealizedValue: mismatchedGross,
      protocolFee: mismatchedProtocolFee,
      creatorFee: mismatchedCreatorFee,
      userValueOut:
        mismatchedGross - mismatchedCreatorFee - mismatchedProtocolFee,
      minValueOut: 0,
      expectedError: /InvalidSettlementValues/,
    });
    const exit = await withdraw({
      basket,
      shareAmount: entry.sharesCredited,
      basketNavValue: finalNavValue,
      sharePrice: finalSharePrice,
      grossRealizedValue: finalNavValue,
      protocolFee,
      creatorFee,
      userValueOut,
    });

    const receipt = await program.account.settlementReceipt.fetch(exit.receipt);
    const storedBasket = await program.account.basket.fetch(basket);
    assert.equal(asNumber(receipt.creatorFee), 2_050_000);
    assert.equal(asNumber(receipt.protocolFee), 1_200_000);
    assert.equal(asNumber(receipt.userValueOut), 116_750_000);
    assert.deepEqual(storedBasket.status, { closed: {} });
    assert.equal(asNumber(storedBasket.protocolFeeShares), 0);
  });

  it("allows a zero-NAV final redemption so a total-loss basket can close", async () => {
    const basket = await createBasket(bytes32());
    const entry = await deposit({
      basket,
      grossAmount: 25 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
    });
    await program.methods
      .beginResolution()
      .accountsStrict({ config, basket, backendSigner: backend.publicKey })
      .signers([backend])
      .rpc();
    await program.methods
      .recordFinalSettlement({
        finalReportHash: asArray(bytes32()),
        finalNavValue: new BN(0),
        finalShareSnapshot: new BN(entry.sharesCredited),
      })
      .accountsStrict({ config, basket, backendSigner: backend.publicKey })
      .signers([backend])
      .rpc();

    await withdraw({
      basket,
      shareAmount: entry.sharesCredited,
      basketNavValue: 0,
      sharePrice: 0,
      grossRealizedValue: 0,
      protocolFee: 0,
      creatorFee: 0,
      userValueOut: 0,
    });
    const storedBasket = await program.account.basket.fetch(basket);
    assert.deepEqual(storedBasket.status, { closed: {} });
    assert.equal(asNumber(storedBasket.totalSharesOutstanding), 0);
  });

  it("closes an empty basket without trapping it in resolution", async () => {
    const basket = await createBasket(bytes32());
    await program.methods
      .beginResolution()
      .accountsStrict({ config, basket, backendSigner: backend.publicKey })
      .signers([backend])
      .rpc();
    await program.methods
      .recordFinalSettlement({
        finalReportHash: asArray(bytes32()),
        finalNavValue: new BN(0),
        finalShareSnapshot: new BN(0),
      })
      .accountsStrict({ config, basket, backendSigner: backend.publicKey })
      .signers([backend])
      .rpc();

    const storedBasket = await program.account.basket.fetch(basket);
    assert.deepEqual(storedBasket.status, { closed: {} });
  });

  it("rejects an expired signed intent without changing accounting", async () => {
    const basket = await createBasket(bytes32());
    const position = positionPda(basket, user.publicKey);
    await deposit({
      basket,
      grossAmount: 50 * ONE_USDC,
      basketNavValue: 0,
      sharePrice: ONE_USDC,
      intentExpiry: 0,
      expectedError: /IntentExpired/,
    });

    const storedPosition = await program.account.position.fetch(position).catch(() => null);
    const storedBasket = await program.account.basket.fetch(basket);
    assert.isNull(storedPosition);
    assert.equal(asNumber(storedBasket.totalSharesOutstanding), 0);
  });
});
