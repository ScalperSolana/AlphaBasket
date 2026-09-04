import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveBackendHttpResponse } from "../src/server/http-server.js";
import type {
  IndexDetailView,
  IndexSummaryView,
  PortfolioHoldingView,
} from "../src/server/read-store.js";

const BASKET = "5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm";
const OWNER = "9fJvqbjzskQbEXZYkTku2gwCacLWPUH3q3aND2xFE3eM";

const summary: IndexSummaryView = {
  address: BASKET,
  basketId: "aa".repeat(32),
  status: "active",
  isPerpetual: true,
  compositionVersion: 1,
  performanceFeeBps: 1_000,
  totalSharesOutstanding: "1000000",
  sharePriceUnits: "1000000",
  grossNavUnits: "1000000",
  assetKinds: ["perp"],
  itemCount: 4,
  updatedAt: "2026-09-04T00:00:00.000Z",
};

const detail: IndexDetailView = {
  ...summary,
  holderCount: 3,
  items: [
    {
      marketId: "SOL",
      kind: "perp",
      weightBps: 2_500,
      perp: {
        direction: "long",
        leverageBps: 30_000,
        entryMarkPrice: "95670000",
        marginPosted: "100000000",
        phoenixSubaccount: 1,
      },
    },
  ],
};

const holding: PortfolioHoldingView = {
  basketAddress: BASKET,
  basketId: summary.basketId,
  sharesOwned: "500000",
  costBasisValue: "500000",
  currentValueUnits: "500000",
  sharePriceUnits: "1000000",
  assetKinds: ["perp"],
};

const reads = {
  listIndexes: async () => [summary],
  getIndex: async (address: string) => (address === BASKET ? detail : null),
  getPortfolio: async (owner: string) => (owner === OWNER ? [holding] : []),
};

const options = {
  health: () => ({ status: "ok" as const }),
  readiness: () => ({ status: "ok" as const }),
  api: {
    financial: {} as never,
    composerBearerToken: "secret",
    allowedOrigins: new Set<string>(),
    reads,
  },
};

const get = (path: string) =>
  resolveBackendHttpResponse("GET", path, options as never, {}, undefined);

describe("index discovery API", () => {
  it("lists indexes without a bearer token", async () => {
    // Everything served here is already public on chain. Requiring a token
    // would only stop a browser from rendering it.
    const response = await get("/v1/indexes");
    assert.equal(response.statusCode, 200);
    const body = response.body as { indexes: IndexSummaryView[] };
    assert.equal(body.indexes.length, 1);
    assert.equal(body.indexes[0]!.address, BASKET);
    assert.deepEqual(body.indexes[0]!.assetKinds, ["perp"]);
  });

  it("returns one index with its composition", async () => {
    const response = await get(`/v1/indexes/${BASKET}`);
    assert.equal(response.statusCode, 200);
    const body = response.body as { index: IndexDetailView };
    assert.equal(body.index.holderCount, 3);
    assert.equal(body.index.items[0]!.kind, "perp");
    assert.equal(body.index.items[0]!.perp!.leverageBps, 30_000);
  });

  it("404s an index the projection does not know", async () => {
    const response = await get(`/v1/indexes/${OWNER}`);
    assert.equal(response.statusCode, 404);
  });

  it("does not match a malformed address as an index", async () => {
    // The route pattern is base58-shaped, so junk falls through to the 404
    // handler rather than reaching the store.
    const response = await get("/v1/indexes/not-a-real-address");
    assert.equal(response.statusCode, 404);
  });

  it("returns a portfolio for an owner", async () => {
    const response = await get(`/v1/portfolio/${OWNER}`);
    assert.equal(response.statusCode, 200);
    const body = response.body as { holdings: PortfolioHoldingView[] };
    assert.equal(body.holdings.length, 1);
    assert.equal(body.holdings[0]!.sharesOwned, "500000");
  });

  it("returns an empty portfolio rather than 404 for an owner with nothing", async () => {
    // An empty portfolio is a valid answer. A 404 would make the page render an
    // error for every new user.
    const response = await get(`/v1/portfolio/${BASKET}`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual((response.body as { holdings: unknown[] }).holdings, []);
  });

  it("still refuses basket creation without the composer token", async () => {
    // The read plane being public must not have loosened the write plane.
    const response = await resolveBackendHttpResponse(
      "POST",
      "/v1/baskets",
      options as never,
      {},
      {},
    );
    assert.equal(response.statusCode, 401);
  });
});
