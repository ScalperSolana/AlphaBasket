import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ClobRestMarketData,
  GammaRestMarketData,
  JsonHttpClient,
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
