import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PublicKey } from "@solana/web3.js";

import {
  JUPITER_AGGREGATOR_PROGRAM_ID,
  JupiterSpotEligibilityService,
  JupiterSwapV2Client,
  JupiterTokensV2Client,
} from "../src/jupiter/index.js";
import { JsonHttpClient } from "../src/polymarket/http-json.js";

const mint = (value: number): PublicKey =>
  new PublicKey(Uint8Array.from({ length: 32 }, () => value));
const settlementMint = mint(1);
const spotMint = mint(2);
const taker = mint(3);

const instruction = (
  programId = JUPITER_AGGREGATOR_PROGRAM_ID,
  signer = taker,
) => ({
  programId: programId.toBase58(),
  accounts: [{
    pubkey: signer.toBase58(),
    isSigner: true,
    isWritable: true,
  }],
  data: Buffer.from([1, 2, 3]).toString("base64"),
});

const buildResponse = (
  overrides: Readonly<Record<string, unknown>> = {},
) => ({
  inputMint: settlementMint.toBase58(),
  outputMint: spotMint.toBase58(),
  inAmount: "1000000",
  outAmount: "500000",
  otherAmountThreshold: "495000",
  swapMode: "ExactIn",
  slippageBps: 100,
  routePlan: [{
    percent: 100,
    bps: 10_000,
    swapInfo: {
      ammKey: mint(4).toBase58(),
      label: "Test AMM",
      inputMint: settlementMint.toBase58(),
      outputMint: spotMint.toBase58(),
      inAmount: "1000000",
      outAmount: "500000",
    },
  }],
  computeBudgetInstructions: [],
  setupInstructions: [],
  swapInstruction: instruction(),
  cleanupInstruction: null,
  otherInstructions: [],
  tipInstruction: null,
  addressesByLookupTableAddress: null,
  blockhashWithMetadata: {
    blockhash: Array.from({ length: 32 }, () => 7),
    lastValidBlockHeight: 123,
  },
  ...overrides,
});

describe("Jupiter Tokens v2 and Swap v2 adapters", () => {
  it("requires an exact Jupiter-verified token record", async () => {
    let requested = "";
    const client = new JupiterTokensV2Client(
      new JsonHttpClient({
        fetch: async (input, init) => {
          requested = input;
          assert.equal(
            new Headers(init.headers).get("x-api-key"),
            "jupiter-key",
          );
          return new Response(JSON.stringify([{
            id: spotMint.toBase58(),
            name: "Example xStock",
            symbol: "EXx",
            decimals: 8,
            tokenProgram: mint(5).toBase58(),
            isVerified: true,
            tags: ["verified", "stocks"],
            updatedAt: "2026-07-01T00:00:00Z",
          }]), { status: 200 });
        },
      }),
      "jupiter-key",
    );

    const token = await client.requireVerified(spotMint);
    assert.equal(token.mint.toBase58(), spotMint.toBase58());
    assert.equal(token.isVerified, true);
    assert.match(requested, /tokens\/v2\/search\?query=/u);
  });

  it("builds an exact-in route and rejects response or signer substitution", async () => {
    let response = buildResponse();
    const client = new JupiterSwapV2Client(
      new JsonHttpClient({
        fetch: async (input, init) => {
          const url = new URL(input);
          assert.equal(url.searchParams.get("amount"), "1000000");
          assert.equal(url.searchParams.get("taker"), taker.toBase58());
          assert.equal(url.searchParams.get("maxAccounts"), "50");
          assert.equal(url.searchParams.get("wrapAndUnwrapSol"), "false");
          assert.equal(
            new Headers(init.headers).get("x-api-key"),
            "jupiter-key",
          );
          return new Response(JSON.stringify(response), { status: 200 });
        },
      }),
      "jupiter-key",
    );

    const built = await client.buildExactIn({
      inputMint: settlementMint,
      outputMint: spotMint,
      amountUnits: 1_000_000n,
      taker,
      slippageBps: 100,
      maxAccounts: 50,
    });
    assert.equal(built.minimumOutAmount, 495_000n);
    assert.equal(
      built.swapInstruction.programId.toBase58(),
      JUPITER_AGGREGATOR_PROGRAM_ID.toBase58(),
    );

    response = buildResponse({ inAmount: "999999" });
    await assert.rejects(
      client.buildExactIn({
        inputMint: settlementMint,
        outputMint: spotMint,
        amountUnits: 1_000_000n,
        taker,
        slippageBps: 100,
        maxAccounts: 50,
      }),
      /does not match/u,
    );

    response = buildResponse({
      swapInstruction: instruction(JUPITER_AGGREGATOR_PROGRAM_ID, mint(9)),
    });
    await assert.rejects(
      client.buildExactIn({
        inputMint: settlementMint,
        outputMint: spotMint,
        amountUnits: 1_000_000n,
        taker,
        slippageBps: 100,
        maxAccounts: 50,
      }),
      /unexpected signer/u,
    );
  });

  it("requires explicit xStocks membership in addition to Jupiter's stocks tag", async () => {
    const tokens = {
      lookup: async () => [],
      requireVerified: async () => ({
        mint: spotMint,
        name: "Example",
        symbol: "EXx",
        decimals: 8,
        tokenProgram: mint(5),
        isVerified: true,
        tags: ["verified", "stocks"],
        updatedAt: null,
      }),
    };
    const swaps = {
      buildExactIn: async () => {
        throw new Error("route must not be queried before xStocks validation");
      },
    };
    const service = new JupiterSpotEligibilityService(tokens, swaps, []);
    await assert.rejects(
      service.requireEligible({
        tokenMint: spotMint,
        assetClass: "tokenized-equity",
        settlementMint,
        routeProbeAmountUnits: 1_000_000n,
        probeTaker: taker,
        slippageBps: 100,
      }),
      /explicit xStocks registry/u,
    );
  });
});
