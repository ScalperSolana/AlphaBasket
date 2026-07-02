# PolyBaskets SliceFund AI server

Backend-only integration of SliceFund's thesis research with the deployed
PolyBaskets Solana escrow. It does not import or modify either frontend.

## What it does

- Converts a plain-English thesis into verified, active Polymarket markets.
- Hydrates every AI selection from Gamma API data; AI-provided market IDs are
  never sent directly on-chain.
- Maps markets to `{ marketId, outcome, weightBps }` and normalizes weights to
  exactly 10,000 basis points.
- Calls the existing Anchor `create_basket`, `stake`, and `claim` instructions.
- Exposes the same capabilities over HTTP and MCP.
- Reads live baskets, settlement state, and wallet positions from Solana RPC.

The thesis mapping and optional Backboard analysis are adapted from
[SliceFund](https://github.com/sxnnywu/slicefund).

## Run locally

```bash
npm install --prefix ai-server
cp .env.example .env
npm run dev:ai
```

Required for AI ranking:

```dotenv
GEMINI_API_KEY=...
```

Required for on-chain basket creation:

```dotenv
AI_OPERATOR_KEYPAIR=<base58 private key or JSON keypair array>
AI_WRITE_API_KEY=<random HTTP write secret>
```

Operator staking also requires the quote signer service at
`AI_QUOTE_API_URL` and a funded devnet-USDC associated token account. HTTP
write routes require `x-api-key: $AI_WRITE_API_KEY`. MCP calls are local and do
not use the HTTP key.

## HTTP routes

- `POST /api/thesis/map`
- `POST /api/thesis/polymarket`
- `POST /api/analyze`
- `GET /api/polymarket/trending`
- `GET /api/polymarket/search?q=...`
- `POST /api/baskets/create`
- `POST /api/baskets/buy`
- `POST /api/baskets/research-and-create`
- `POST /api/baskets/prepare-stake`
- `POST /api/baskets/prepare-claim`
- `POST /api/baskets/claim`
- `GET /api/baskets`
- `GET /api/baskets/:basketId`
- `GET /api/positions/:owner`

The old SliceFund `/api/mock/polymarket/execute-basket` and
`/api/mock/polymarket/buy-basket` routes are intentionally not present.

## MCP configuration

```json
{
  "mcpServers": {
    "polybaskets": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/AlphaBasket/ai-server", "run", "mcp"],
      "env": {
        "GEMINI_API_KEY": "...",
        "AI_OPERATOR_KEYPAIR_FILE": "/absolute/path/to/operator-keypair.json",
        "AI_QUOTE_API_URL": "http://127.0.0.1:4360"
      }
    }
  }
}
```

Available tools include `research_thesis`, `create_basket_onchain`,
`research_and_create_basket`, `stake_operator_wallet`, `prepare_user_stake`,
`prepare_user_claim`, `claim_operator_position`, `get_basket`, `list_baskets`,
and `get_wallet_positions`.

User stake and claim tools return unsigned serialized transactions bound to the
specified wallet. The external wallet must sign them; the service never signs
for an arbitrary user.
