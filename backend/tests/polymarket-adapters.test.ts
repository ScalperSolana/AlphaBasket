import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ClobFakRestExecution,
  ClobRestMarketData,
  GammaRestMarketData,
  JsonHttpClient,
  PolymarketBridgeRest,
  calculateExecutableDepth,
} from "../src/polymarket/index.js";

const jsonClient = (payload: unknown) =>
  new JsonHttpClient({
    fetch: async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

describe("Polymarket read adapters", () => {
  it("maps the documented Gamma keyset response without using conditionId on-chain", async () => {
    const conditionId = `0x${"ab".repeat(32)}`;
    const adapter = new GammaRestMarketData(
      jsonClient({
        markets: [
          {
            id: "12345",
            conditionId,
            events: [{ id: "event-7" }],
            question: "Will the test pass?",
            slug: "test-pass",
            active: true,
            closed: false,
            acceptingOrders: true,
            endDate: "2030-01-01T00:00:00Z",
            volume24hr: 123.5,
            liquidity: "456.25",
            clobTokenIds: '["10","11"]',
            outcomes: '["Yes","No"]',
          },
        ],
        next_cursor: "cursor-2",
      }),
    );
    const page = await adapter.listMarkets({ limit: 20 });
    const market = page.markets[0];
    assert.equal(market?.marketId, "12345");
    assert.equal(market?.conditionId, conditionId);
    assert.equal(market?.eventId, "event-7");
    assert.equal(market?.volume24hUnits, 123_500_000n);
    assert.equal(market?.liquidityUnits, 456_250_000n);
    assert.equal(page.nextCursor, "cursor-2");
  });

  it("validates token identity, tick alignment, ordering and executable depth", async () => {
    const bookPayload = {
      market: `0x${"11".repeat(32)}`,
      asset_id: "10",
      timestamp: "2000000000000",
      bids: [
        { price: "0.48", size: "100" },
        { price: "0.47", size: "200" },
      ],
      asks: [
        { price: "0.52", size: "80" },
        { price: "0.53", size: "150" },
      ],
      min_order_size: "1",
      tick_size: "0.01",
      neg_risk: false,
      hash: "book-hash",
    };
    const book = await new ClobRestMarketData(jsonClient(bookPayload)).getOrderBook("10");
    assert.equal(calculateExecutableDepth(book, "buy", 520_000n), 41_600_000n);
    assert.equal(book.sourceHash, "book-hash");

    await assert.rejects(
      new ClobRestMarketData(
        jsonClient({ ...bookPayload, asset_id: "different" }),
      ).getOrderBook("10"),
      /returned asset_id/u,
    );
    await assert.rejects(
      new ClobRestMarketData(
        jsonClient({
          ...bookPayload,
          bids: [
            { price: "0.47", size: "1" },
            { price: "0.48", size: "1" },
          ],
        }),
      ).getOrderBook("10"),
      /bids must be sorted/u,
    );
    await assert.rejects(
      new ClobRestMarketData(
        jsonClient({ ...bookPayload, asks: [{ price: "0.525", size: "1" }] }),
      ).getOrderBook("10"),
      /aligned to tick/u,
    );
  });
});

describe("Polymarket execution adapters", () => {
  it("uses the documented bridge request shapes and preserves optional output amounts", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const http = new JsonHttpClient({
      fetch: async (url, init) => {
        requests.push({ url, init });
        const payload = url.endsWith("/status/bridge-address-123")
          ? { transactions: [{ fromAmountBaseUnit: "995000", toAmountBaseUnit: "994500", status: "COMPLETED", txHash: "destination-tx", createdTimeMs: "2000000000000" }] }
          : { address: { evm: `0x${"11".repeat(20)}`, svm: "11111111111111111111111111111111" } };
        return new Response(JSON.stringify(payload), { status: url.includes("/withdraw") ? 201 : 200 });
      },
    });
    const bridge = new PolymarketBridgeRest(http, { builderCode: `0x${"22".repeat(32)}` });
    await bridge.createDepositAddress(`0x${"33".repeat(20)}`);
    await bridge.createWithdrawalAddress({
      polymarketWallet: `0x${"44".repeat(20)}`,
      solanaRecipient: "11111111111111111111111111111111",
      solanaChainId: "1151111081099710",
      solanaUsdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });
    const status = await bridge.getStatus("bridge-address-123");
    assert.equal(status[0]?.inputAmountUnits, 995_000n);
    assert.equal(status[0]?.outputAmountUnits, 994_500n);
    assert.equal(requests[0]?.init.headers && (requests[0].init.headers as Record<string, string>)["X-Builder-Code"], `0x${"22".repeat(32)}`);
    assert.match(String(requests[1]?.init.body), /1151111081099710/u);
  });

  it("submits FAK only and classifies a partial immediate fill", async () => {
    let postedBody = "";
    const adapter = new ClobFakRestExecution(
      new JsonHttpClient({
        fetch: async (_url, init) => {
          postedBody = String(init.body);
          return new Response(JSON.stringify({
            success: true,
            orderID: "order-1",
            status: "matched",
            makingAmount: "500000",
            takingAmount: "1000000",
            transactionsHashes: ["tx-1"],
            tradeIDs: ["trade-1"],
            errorMsg: "",
          }), { status: 200 });
        },
      }),
      {
        signFakOrder: async (request) => ({
          serializedBody: JSON.stringify({
            order: {
              tokenId: request.tokenId,
              makerAmount: request.makerAmountUnits.toString(10),
            },
            owner: "owner",
            orderType: "FAK",
            deferExec: false,
            postOnly: false,
          }),
          authenticationHeaders: { POLY_API_KEY: "redacted-test-key" },
        }),
      },
    );
    const result = await adapter.executeFak({
      clientOrderId: "client-1",
      tokenId: "token-1",
      side: "buy",
      negativeRisk: false,
      amountUnits: 1_000_000n,
      worstPriceUnits: 500_000n,
    });
    assert.equal(result.status, "partially_filled");
    assert.equal(result.averagePriceUnits, 500_000n);
    assert.match(postedBody, /"orderType":"FAK"/u);
    assert.match(postedBody, /"postOnly":false/u);
  });

  it("does not treat a delayed FAK response as a finalized fill", async () => {
    const adapter = new ClobFakRestExecution(
      new JsonHttpClient({
        fetch: async () => new Response(JSON.stringify({
          success: true,
          orderID: "order-delayed",
          status: "delayed",
          makingAmount: "0",
          takingAmount: "0",
          errorMsg: "",
        }), { status: 200 }),
      }),
      {
        signFakOrder: async () => ({
          serializedBody: JSON.stringify({
            order: {},
            owner: "owner",
            orderType: "FAK",
            deferExec: false,
            postOnly: false,
          }),
          authenticationHeaders: {},
        }),
      },
    );
    await assert.rejects(adapter.executeFak({
      clientOrderId: "client-delayed",
      tokenId: "token-1",
      side: "buy",
      negativeRisk: false,
      amountUnits: 1_000_000n,
      worstPriceUnits: 500_000n,
    }), /delayed/u);
  });
});
