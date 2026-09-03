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
const FAR_EXPIRY = 4_102_444_800;
const COMPOSITION_DOMAIN = Buffer.from("AB_CREATE_V2");

const asArray = (value: Buffer) => [...value];

const u16 = (value: number) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
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

type PerpKind = {
  perp: {
    direction: { long: {} } | { short: {} };
    leverageBps: number;
    entryMarkPrice: BN;
    marginPosted: BN;
    phoenixSubaccount: number;
  };
};
type BasketAsset = {
  marketId: string;
  kind: PerpKind | { predictionMarket: { outcome: number; ctfTokenId: number[] } };
  weightBps: number;
};

const perp = (
  marketId: string,
  phoenixSubaccount: number,
  weightBps: number,
  options: {
    short?: boolean;
    leverageBps?: number;
    entryMarkPrice?: number;
    marginPosted?: number;
  } = {},
): BasketAsset => ({
  marketId,
  kind: {
    perp: {
      direction: options.short ? { short: {} } : { long: {} },
      leverageBps: options.leverageBps ?? 30_000,
      entryMarkPrice: new BN(options.entryMarkPrice ?? 95_670_000),
      marginPosted: new BN(options.marginPosted ?? 100_000_000),
      phoenixSubaccount,
    },
  },
  weightBps,
});

const predictionMarket = (
  marketId: string,
  outcome: number,
  weightBps: number,
  ctfByte: number,
): BasketAsset => ({
  marketId,
  kind: {
    predictionMarket: { outcome, ctfTokenId: asArray(Buffer.alloc(32, ctfByte)) },
  },
  weightBps,
});

/**
 * Mirrors `canonical_composition_bytes` in `create_basket.rs`.
 *
 * `entryMarkPrice` and `marginPosted` are deliberately absent from the perp
 * encoding: settlement rewrites both in place, so hashing them would make the
 * composition hash stop matching the composition after the first fill.
 */
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
      const p = item.kind.perp;
      return Buffer.concat([
        u16(market.length),
        market,
        Buffer.from([2, "short" in p.direction ? 1 : 0]),
        u16(p.leverageBps),
        Buffer.from([p.phoenixSubaccount]),
        u16(item.weightBps),
      ]);
    }),
  ]);

const hashComposition = (items: BasketAsset[]) =>
  createHash("sha256").update(canonicalComposition(items)).digest();

/** Mirrors `canonical_perp_eligibility_bytes` in `registry.rs`. */
const canonicalPerpEligibility = (markets: string[]) =>
  Buffer.concat([
    u16(markets.length),
    ...markets.map((marketId) => {
      const bytes = Buffer.from(marketId);
      return Buffer.concat([u16(bytes.length), bytes]);
    }),
  ]);

const hashPerpEligibility = (markets: string[]) =>
  createHash("sha256").update(canonicalPerpEligibility(markets)).digest();

/** Mirrors `canonical_eligibility_bytes` for the empty prediction list. */
const hashEmptyEligibility = () =>
  createHash("sha256").update(u16(0)).digest();

describe("Phoenix perpetual settlement (bankrun)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let banksClient: BanksClient;
  let program: Program<PolybasketsEscrow>;
  let payer: Keypair;

  const composer = Keypair.generate();
  const backend = Keypair.generate();
  const admin = Keypair.generate();
  const creator = Keypair.generate().publicKey;
  const creatorFeeDestination = Keypair.generate().publicKey;
  const executionWallet = Keypair.generate().publicKey;
  let config: PublicKey;
  let compositionNonce = 0;
  let eligibilityNonce = 0;
  let perpListNonce = 0;
  let basketCounter = 0;

  const MARKETS = ["SOL", "BTC", "ETH", "HYPE"];
  /** Four items, because a single item may not exceed 3000 bps. */
  const perpItems: BasketAsset[] = [
    perp("SOL", 1, 2_500),
    perp("BTC", 2, 2_500),
    perp("ETH", 3, 2_500),
    perp("HYPE", 4, 2_500),
  ];

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
  const basketPda = (id: Buffer) => pda([Buffer.from("basket"), id]);
  const perpReceiptPda = (hash: Buffer) => pda([Buffer.from("perp_receipt"), hash]);
  const perpEventPda = (hash: Buffer) => pda([Buffer.from("perp_event"), hash]);
  const traderRegistryPda = (wallet: PublicKey) =>
    pda([Buffer.from("perp_trader"), wallet.toBuffer()]);

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

  const fundSol = (recipient: PublicKey) =>
    sendTx([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports: 5_000_000_000,
      }),
    ]);

  async function publishPerpList(markets: string[] = MARKETS): Promise<PublicKey> {
    const nonce = ++perpListNonce;
    const listHash = hashPerpEligibility(markets);
    const account = pda([
      Buffer.from("perp_eligibility"),
      listHash,
      u64(nonce),
    ]);
    const clock = await banksClient.getClock();
    await program.methods
      .publishPerpEligibilityList({
        listHash: asArray(listHash),
        nonce: new BN(nonce),
        expiresAt: new BN(clock.unixTimestamp + 600n),
        markets: markets.map((marketId) => ({ marketId })),
      })
      .accountsStrict({
        config,
        perpEligibilityList: account,
        composerSigner: composer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([composer])
      .rpc();
    return account;
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

  /**
   * Publishes both lists, the draft, and creates the basket. Returns the pieces
   * later tests need. `expectRevertAt` lets a test stop before the final send.
   */
  async function createPerpBasket(options: {
    items?: BasketAsset[];
    perpMarkets?: string[];
    perpList?: PublicKey;
    build?: boolean;
  } = {}) {
    const items = options.items ?? perpItems;
    const basketId = Buffer.alloc(32, ++basketCounter);

    const listNonce = ++eligibilityNonce;
    const eligibilityHash = hashEmptyEligibility();
    const eligibilityList = pda([
      Buffer.from("eligibility"),
      eligibilityHash,
      u64(listNonce),
    ]);
    const clock = await banksClient.getClock();
    await program.methods
      .publishEligibilityList({
        listHash: asArray(eligibilityHash),
        nonce: new BN(listNonce),
        expiresAt: new BN(clock.unixTimestamp + 600n),
        markets: [],
      })
      .accountsStrict({
        config,
        eligibilityList,
        composerSigner: composer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([composer])
      .rpc();

    const perpList =
      options.perpList ?? (await publishPerpList(options.perpMarkets ?? MARKETS));
    const extra = [{ pubkey: perpList, isSigner: false, isWritable: false }];

    const compositionHash = hashComposition(items);
    const nonce = ++compositionNonce;
    const compositionDraft = pda([
      Buffer.from("composition_draft"),
      compositionHash,
      u64(nonce),
    ]);

    const draftIx = await program.methods
      .publishCompositionDraft({
        compositionHash: asArray(compositionHash),
        eligibilityHash: asArray(eligibilityHash),
        eligibilityNonce: new BN(listNonce),
        compositionNonce: new BN(nonce),
        items,
      })
      .accountsStrict({
        config,
        compositionDraft,
        eligibilityList,
        composerSigner: composer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(extra)
      .instruction();

    const args = {
      basketId,
      eligibilityHash,
      eligibilityNonce: listNonce,
      performanceFeeBps: 1_000,
      isPerpetual: true,
      reconstitutionCadenceSecs: 86_400,
      compositionNonce: nonce,
      compositionExpiry: FAR_EXPIRY,
    };
    const signatureIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: composer.secretKey,
      message: compositionMessage(args),
    });
    const createIx = await program.methods
      .createBasket({
        basketId: asArray(basketId),
        compositionHash: asArray(compositionHash),
        eligibilityHash: asArray(eligibilityHash),
        eligibilityNonce: new BN(listNonce),
        creator,
        creatorFeeDestination,
        performanceFeeBps: args.performanceFeeBps,
        isPerpetual: args.isPerpetual,
        reconstitutionCadenceSecs: new BN(args.reconstitutionCadenceSecs),
        compositionNonce: new BN(nonce),
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
      })
      .remainingAccounts(extra)
      .instruction();

    return {
      basketId,
      basket: basketPda(basketId),
      compositionHash,
      perpList,
      draftIx,
      signatureIx,
      createIx,
      async submit() {
        await sendTx([draftIx], [composer]);
        await sendTx([signatureIx, createIx], [composer]);
        return basketPda(basketId);
      },
    };
  }

  async function onboard(wallet: PublicKey = executionWallet) {
    const clock = await banksClient.getClock();
    await program.methods
      .onboardTraderAccount({
        executionWallet: wallet,
        phoenixTraderPda: Keypair.generate().publicKey,
        phoenixPdaIndex: 0,
        onboardedAt: new BN(clock.unixTimestamp.toString()),
        onboardingSignature: asArray(Buffer.alloc(64, 3)),
      })
      .accountsStrict({
        config,
        registry: traderRegistryPda(wallet),
        backendSigner: backend.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([backend])
      .rpc();
    return traderRegistryPda(wallet);
  }

  let settlementNonce = 0;

  async function tradeIx(args: {
    basket: PublicKey;
    basketId: Buffer;
    compositionHash: Buffer;
    perpList: PublicKey;
    executionHash: Buffer;
    marketId?: string;
    subaccount?: number;
    side?: "open" | "close";
    entryMarkPrice?: number;
    marginPosted?: number;
    settlementNonce?: number;
    compositionVersion?: number;
    leverageBps?: number;
  }) {
    const clock = await banksClient.getClock();
    return program.methods
      .completePhoenixTrade({
        executionHash: asArray(args.executionHash),
        requestHash: asArray(Buffer.alloc(32, 12)),
        idempotencyKey: asArray(Buffer.alloc(32, 13)),
        settlementNonce: new BN(args.settlementNonce ?? ++settlementNonce),
        basketId: asArray(args.basketId),
        expectedCompositionVersion: args.compositionVersion ?? 1,
        expectedCompositionHash: asArray(args.compositionHash),
        marketId: args.marketId ?? "SOL",
        side: args.side === "close" ? { close: {} } : { open: {} },
        direction: { long: {} },
        phoenixSubaccount: args.subaccount ?? 1,
        leverageBps: args.leverageBps ?? 30_000,
        executionWallet,
        requestedCollateralUnits: new BN(100_000_000),
        actualMarginPostedUnits: new BN(args.marginPosted ?? 97_431_255),
        entryMarkPrice: new BN(args.entryMarkPrice ?? 95_670_000),
        fillStatus: { filled: {} },
        executedAt: new BN(clock.unixTimestamp.toString()),
        executedSlot: new BN(1),
        transactionSignature: asArray(Buffer.alloc(64, 4)),
      })
      .accountsStrict({
        config,
        basket: args.basket,
        perpEligibilityList: args.perpList,
        traderRegistry: traderRegistryPda(executionWallet),
        receipt: perpReceiptPda(args.executionHash),
        backendSigner: backend.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
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
        protocol_treasury: Keypair.generate().publicKey,
        settlement_mint: Keypair.generate().publicKey,
        max_slippage_bps: 1_000,
        accounting_decimals: 6,
        paused: false,
        bump: configBump,
      },
    );
    const configData = Buffer.alloc(256);
    encodedConfig.copy(configData);
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
    await fundSol(admin.publicKey);
    await fundSol(composer.publicKey);
    await fundSol(backend.publicKey);
  });

  describe("publish_perp_eligibility_list", () => {
    it("publishes a Composer-signed perp market list", async () => {
      const account = await publishPerpList(["SOL", "BTC"]);
      const list = await program.account.perpEligibilityList.fetch(account);
      assert.equal(list.markets.length, 2);
      assert.equal(list.markets[0]!.marketId, "SOL");
      assert.isTrue(list.composer.equals(composer.publicKey));
    });

    it("rejects a list whose hash does not match its contents", async () => {
      const nonce = ++perpListNonce;
      const wrongHash = hashPerpEligibility(["SOL"]);
      const clock = await banksClient.getClock();
      const ix = await program.methods
        .publishPerpEligibilityList({
          listHash: asArray(wrongHash),
          nonce: new BN(nonce),
          expiresAt: new BN(clock.unixTimestamp + 600n),
          // Contents disagree with the hash above.
          markets: [{ marketId: "BTC" }],
        })
        .accountsStrict({
          config,
          perpEligibilityList: pda([
            Buffer.from("perp_eligibility"),
            wrongHash,
            u64(nonce),
          ]),
          composerSigner: composer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      await expectRevert([ix], [composer], /InvalidPerpEligibilityList/);
    });

    it("rejects duplicate markets in one list", async () => {
      const nonce = ++perpListNonce;
      const markets = ["SOL", "SOL"];
      const hash = hashPerpEligibility(markets);
      const clock = await banksClient.getClock();
      const ix = await program.methods
        .publishPerpEligibilityList({
          listHash: asArray(hash),
          nonce: new BN(nonce),
          expiresAt: new BN(clock.unixTimestamp + 600n),
          markets: markets.map((marketId) => ({ marketId })),
        })
        .accountsStrict({
          config,
          perpEligibilityList: pda([
            Buffer.from("perp_eligibility"),
            hash,
            u64(nonce),
          ]),
          composerSigner: composer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      await expectRevert([ix], [composer], /InvalidPerpEligibilityList/);
    });
  });

  describe("create_basket with perpetual items", () => {
    it("creates a four-item perpetual basket", async () => {
      const fixture = await createPerpBasket();
      const basket = await fixture.submit();
      const state = await program.account.basket.fetch(basket);
      assert.equal(state.items.length, 4);
      assert.equal(state.compositionVersion, 1);
      assert.deepEqual(state.status, { active: {} });
      const item = state.items[0]!;
      assert.equal(item.marketId, "SOL");
      assert.equal((item.kind as any).perp.phoenixSubaccount, 1);
      assert.equal((item.kind as any).perp.leverageBps, 30_000);
    });

    it("rejects a basket that mixes perpetuals with prediction markets", async () => {
      // The isolation and leverage properties of a perp make a mixed basket's NAV
      // undecomposable, so the program refuses one outright.
      const fixture = await createPerpBasket({
        items: [
          perp("SOL", 1, 2_500),
          perp("BTC", 2, 2_500),
          predictionMarket("market-a", 1, 2_500, 1),
          predictionMarket("market-b", 0, 2_500, 2),
        ],
      });
      await expectRevert([fixture.draftIx], [composer], /MixedAssetClassBasket/);
    });

    it("rejects Phoenix subaccount zero", async () => {
      const fixture = await createPerpBasket({
        items: [
          perp("SOL", 0, 2_500),
          perp("BTC", 2, 2_500),
          perp("ETH", 3, 2_500),
          perp("HYPE", 4, 2_500),
        ],
      });
      await expectRevert([fixture.draftIx], [composer], /SubaccountZeroNotAllowed/);
    });

    it("rejects leverage outside the supported bounds", async () => {
      const fixture = await createPerpBasket({
        items: [
          perp("SOL", 1, 2_500, { leverageBps: 9_999 }),
          perp("BTC", 2, 2_500),
          perp("ETH", 3, 2_500),
          perp("HYPE", 4, 2_500),
        ],
      });
      await expectRevert([fixture.draftIx], [composer], /PerpLeverageOutOfBounds/);
    });

    it("rejects a market absent from the perp eligibility list", async () => {
      const fixture = await createPerpBasket({
        perpMarkets: ["BTC", "ETH", "HYPE"], // SOL missing
      });
      await expectRevert([fixture.draftIx], [composer], /MarketNotEligible/);
    });

    it("rejects two items sharing one isolated subaccount", async () => {
      // Sharing a subaccount would share collateral, which is the thing isolation
      // exists to prevent.
      const fixture = await createPerpBasket({
        items: [
          perp("SOL", 1, 2_500),
          perp("BTC", 1, 2_500),
          perp("ETH", 3, 2_500),
          perp("HYPE", 4, 2_500),
        ],
      });
      await expectRevert([fixture.draftIx], [composer], /InvalidBasketItems/);
    });

    it("excludes settlement-written fields from the composition hash", () => {
      // Two compositions differing only in margin and entry price must hash the
      // same, or the first fill would invalidate the basket's composition hash.
      const a = [perp("SOL", 1, 10_000, { marginPosted: 1, entryMarkPrice: 2 })];
      const b = [
        perp("SOL", 1, 10_000, { marginPosted: 999, entryMarkPrice: 888 }),
      ];
      assert.deepEqual(hashComposition(a), hashComposition(b));

      // But a change to an approved term must change the hash.
      const c = [perp("SOL", 2, 10_000)];
      assert.notDeepEqual(hashComposition(a), hashComposition(c));
    });
  });

  describe("onboard_trader_account", () => {
    it("records the registry once and refuses a second onboarding", async () => {
      const wallet = Keypair.generate().publicKey;
      const registry = await onboard(wallet);
      const state = await program.account.traderAccountRegistry.fetch(registry);
      assert.isTrue(state.executionWallet.equals(wallet));
      assert.equal(state.phoenixPdaIndex, 0);

      const clock = await banksClient.getClock();
      const ix = await program.methods
        .onboardTraderAccount({
          executionWallet: wallet,
          phoenixTraderPda: Keypair.generate().publicKey,
          phoenixPdaIndex: 0,
          onboardedAt: new BN(clock.unixTimestamp.toString()),
          onboardingSignature: asArray(Buffer.alloc(64, 9)),
        })
        .accountsStrict({
          config,
          registry,
          backendSigner: backend.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      await expectRevert([ix], [backend], /already in use|custom program error: 0x0/);
    });

    it("rejects a non-zero Phoenix trader PDA index", async () => {
      const wallet = Keypair.generate().publicKey;
      const clock = await banksClient.getClock();
      const ix = await program.methods
        .onboardTraderAccount({
          executionWallet: wallet,
          phoenixTraderPda: Keypair.generate().publicKey,
          phoenixPdaIndex: 1,
          onboardedAt: new BN(clock.unixTimestamp.toString()),
          onboardingSignature: asArray(Buffer.alloc(64, 9)),
        })
        .accountsStrict({
          config,
          registry: traderRegistryPda(wallet),
          backendSigner: backend.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      await expectRevert([ix], [backend], /UnsupportedTraderPdaIndex/);
    });
  });

  describe("complete_phoenix_trade", () => {
    let fixture: Awaited<ReturnType<typeof createPerpBasket>>;
    let basket: PublicKey;

    before(async () => {
      await onboard();
      fixture = await createPerpBasket();
      basket = await fixture.submit();
    });

    it("records the real post-execution figures on the matching item", async () => {
      const hash = Buffer.alloc(32, 21);
      const before = await program.account.basket.fetch(basket);
      const ix = await tradeIx({ ...fixture, basket, executionHash: hash });
      await sendTx([ix], [backend]);

      const receipt = await program.account.perpSettlementReceipt.fetch(
        perpReceiptPda(hash),
      );
      assert.equal(receipt.marketId, "SOL");
      // The actual figure is stored, not the requested one, and they differ.
      assert.equal(receipt.requestedCollateralUnits.toNumber(), 100_000_000);
      assert.equal(receipt.actualMarginPostedUnits.toNumber(), 97_431_255);

      const after = await program.account.basket.fetch(basket);
      const item = after.items[0]!.kind as any;
      assert.equal(item.perp.marginPosted.toNumber(), 97_431_255);
      assert.equal(item.perp.entryMarkPrice.toNumber(), 95_670_000);
      // Terms the Composer approved are not outcomes of a fill.
      assert.equal(item.perp.leverageBps, 30_000);
      assert.deepEqual(item.perp.direction, { long: {} });

      // The composition itself did not change.
      assert.deepEqual(after.compositionHash, before.compositionHash);
      assert.equal(after.compositionVersion, before.compositionVersion);
      assert.equal(after.items.length, before.items.length);
      // Every other item is byte-identical.
      for (const index of [1, 2, 3]) {
        assert.deepEqual(after.items[index], before.items[index]);
      }
    });

    it("rejects a replay of the same execution hash", async () => {
      const hash = Buffer.alloc(32, 21);
      const ix = await tradeIx({ ...fixture, basket, executionHash: hash });
      await expectRevert([ix], [backend], /already in use|custom program error: 0x0/);
    });

    it("rejects a stale composition version", async () => {
      const ix = await tradeIx({
        ...fixture,
        basket,
        executionHash: Buffer.alloc(32, 22),
        compositionVersion: 2,
      });
      await expectRevert([ix], [backend], /CompositionVersionMismatch/);
    });

    it("rejects a settlement nonce that does not increase", async () => {
      const ix = await tradeIx({
        ...fixture,
        basket,
        executionHash: Buffer.alloc(32, 23),
        settlementNonce: 1,
      });
      await expectRevert([ix], [backend], /SettlementNonceNotIncreasing/);
    });

    it("rejects a subaccount the composition does not bind", async () => {
      const ix = await tradeIx({
        ...fixture,
        basket,
        executionHash: Buffer.alloc(32, 24),
        subaccount: 9,
      });
      await expectRevert([ix], [backend], /SubaccountMismatch/);
    });

    it("rejects subaccount zero", async () => {
      const ix = await tradeIx({
        ...fixture,
        basket,
        executionHash: Buffer.alloc(32, 25),
        subaccount: 0,
      });
      await expectRevert([ix], [backend], /SubaccountZeroNotAllowed/);
    });

    it("rejects a market absent from the composition", async () => {
      const ix = await tradeIx({
        ...fixture,
        basket,
        executionHash: Buffer.alloc(32, 26),
        marketId: "DOGE",
      });
      await expectRevert([ix], [backend], /MarketNotEligible/);
    });

    it("rejects an open that posted no margin", async () => {
      const ix = await tradeIx({
        ...fixture,
        basket,
        executionHash: Buffer.alloc(32, 27),
        marginPosted: 0,
      });
      await expectRevert([ix], [backend], /ZeroMarginPosted/);
    });

    it("rejects an open with no entry price", async () => {
      const ix = await tradeIx({
        ...fixture,
        basket,
        executionHash: Buffer.alloc(32, 28),
        entryMarkPrice: 0,
      });
      await expectRevert([ix], [backend], /ZeroEntryMarkPrice/);
    });

    it("settles a full close and keeps the last known entry price", async () => {
      // Flattening a position leaves nothing to price and sweeps the isolated
      // collateral back to the parent, so a real close reports zero for both.
      // Writing that zero over the entry price would destroy the only record of
      // where the position was opened.
      const ix = await tradeIx({
        ...fixture,
        basket,
        executionHash: Buffer.alloc(32, 29),
        side: "close",
        entryMarkPrice: 0,
        marginPosted: 0,
      });
      await sendTx([ix], [backend]);

      const after = await program.account.basket.fetch(basket);
      const item = after.items[0]!.kind as any;
      assert.equal(item.perp.marginPosted.toNumber(), 0);
      assert.equal(item.perp.entryMarkPrice.toNumber(), 95_670_000);
    });

    it("rejects a fill against a basket that is not Active", async () => {
      // `begin_reconstitution` is gated on the basket's cadence, so move the
      // clock past it first.
      await warpSeconds(86_401);
      await program.methods
        .beginReconstitution()
        .accountsStrict({ config, basket, backendSigner: backend.publicKey })
        .signers([backend])
        .rpc();

      const ix = await tradeIx({
        ...fixture,
        basket,
        executionHash: Buffer.alloc(32, 30),
      });
      await expectRevert([ix], [backend], /InvalidBasketStatus/);
    });
  });

  describe("attest_perp_event", () => {
    let basket: PublicKey;
    let basketId: Buffer;

    before(async () => {
      const fixture = await createPerpBasket();
      basket = await fixture.submit();
      basketId = fixture.basketId;
    });

    const attestIx = async (hash: Buffer, options: { nonce?: number } = {}) => {
      const clock = await banksClient.getClock();
      return program.methods
        .attestPerpEvent({
          eventHash: asArray(hash),
          basketId: asArray(basketId),
          eventKind: { adl: {} },
          marketId: "SOL",
          phoenixSubaccount: 1,
          detailHash: asArray(Buffer.alloc(32, 7)),
          observedAt: new BN(clock.unixTimestamp.toString()),
          observedSlot: new BN(1),
          attestationNonce: new BN(options.nonce ?? 1),
        })
        .accountsStrict({
          config,
          basket,
          attestation: perpEventPda(hash),
          backendSigner: backend.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
    };

    it("records an ADL with no prior trade", async () => {
      const hash = Buffer.alloc(32, 41);
      await sendTx([await attestIx(hash)], [backend]);
      const state = await program.account.perpEventAttestation.fetch(
        perpEventPda(hash),
      );
      assert.equal(state.marketId, "SOL");
      assert.deepEqual(state.eventKind, { adl: {} });
      assert.isTrue(state.basket.equals(basket));
    });

    it("records the same event exactly once", async () => {
      const hash = Buffer.alloc(32, 41);
      await expectRevert(
        [await attestIx(hash, { nonce: 2 })],
        [backend],
        /already in use|custom program error: 0x0/,
      );
    });

    it("still records while the program is paused", async () => {
      // Pausing stops AlphaBasket from acting. It does not stop Phoenix, and
      // dropping events while paused would lose exactly the records needed to
      // understand why the pause mattered.
      await program.methods
        .setPaused(true)
        .accountsStrict({ config, admin: admin.publicKey })
        .signers([admin])
        .rpc();

      await sendTx([await attestIx(Buffer.alloc(32, 42))], [backend]);

      await program.methods
        .setPaused(false)
        .accountsStrict({ config, admin: admin.publicKey })
        .signers([admin])
        .rpc();
    });

    it("rejects an event for a basket the args do not name", async () => {
      const other = await createPerpBasket();
      const otherBasket = await other.submit();
      const hash = Buffer.alloc(32, 43);
      const clock = await banksClient.getClock();
      const ix = await program.methods
        .attestPerpEvent({
          eventHash: asArray(hash),
          basketId: asArray(basketId), // names the first basket
          eventKind: { adl: {} },
          marketId: "SOL",
          phoenixSubaccount: 1,
          detailHash: asArray(Buffer.alloc(32, 7)),
          observedAt: new BN(clock.unixTimestamp.toString()),
          observedSlot: new BN(1),
          attestationNonce: new BN(1),
        })
        .accountsStrict({
          config,
          basket: otherBasket, // but passes the second
          attestation: perpEventPda(hash),
          backendSigner: backend.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      await expectRevert([ix], [backend], /MismatchedBasket/);
    });
  });
});
