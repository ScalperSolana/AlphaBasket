import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { canonicalBasketSchema, thesisRequestSchema } from './schema.js';
import { researchThesis } from './thesis.js';
import {
  createBasketOnchain,
  claimWithOperator,
  escrowInfo,
  getBasket,
  getWalletPositions,
  listBaskets,
  prepareClaimTransaction,
  prepareStakeTransaction,
  stakeWithOperator,
} from './solana.js';

const server = new McpServer({ name: 'polybaskets-slicefund', version: '0.1.0' });

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

server.registerTool(
  'research_thesis',
  {
    description: 'Research a thesis and return a verified, Polymarket-only basket normalized to 10,000 basis points.',
    inputSchema: thesisRequestSchema.shape,
  },
  async (input) => text(await researchThesis(thesisRequestSchema.parse(input))),
);

server.registerTool(
  'create_basket_onchain',
  {
    description: 'Create a verified basket on the PolyBaskets devnet escrow using the configured operator wallet.',
    inputSchema: canonicalBasketSchema.shape,
  },
  async (input) => text(await createBasketOnchain(canonicalBasketSchema.parse(input))),
);

server.registerTool(
  'research_and_create_basket',
  {
    description: 'Research a thesis, verify real Polymarket IDs, normalize weights, and create the resulting basket on-chain.',
    inputSchema: thesisRequestSchema.shape,
  },
  async (input) => {
    const research = await researchThesis(thesisRequestSchema.parse(input));
    const created = await createBasketOnchain(research.basket);
    return text({ research, created });
  },
);

server.registerTool(
  'stake_operator_wallet',
  {
    description: 'Stake devnet USDC from the configured operator wallet into an existing basket.',
    inputSchema: {
      basketId: z.string().min(1),
      amountUsdc: z.union([z.string(), z.number()]),
    },
  },
  async ({ basketId, amountUsdc }) => text(await stakeWithOperator(basketId, amountUsdc)),
);

server.registerTool(
  'prepare_user_stake',
  {
    description: 'Return a serialized stake transaction and signed entry-index quote for an external user wallet to sign.',
    inputSchema: {
      basketId: z.string().min(1),
      owner: z.string().min(32),
      amountUsdc: z.union([z.string(), z.number()]),
    },
  },
  async ({ basketId, owner, amountUsdc }) => text(await prepareStakeTransaction(basketId, owner, amountUsdc)),
);

server.registerTool(
  'get_basket',
  {
    description: 'Read an escrow basket, including composition and settlement state.',
    inputSchema: { basketId: z.string().min(1) },
  },
  async ({ basketId }) => text(await getBasket(basketId)),
);

server.registerTool(
  'prepare_user_claim',
  {
    description: 'Return a serialized claim transaction for an external wallet to sign after settlement.',
    inputSchema: { basketId: z.string().min(1), owner: z.string().min(32) },
  },
  async ({ basketId, owner }) => text(await prepareClaimTransaction(basketId, owner)),
);

server.registerTool(
  'claim_operator_position',
  {
    description: 'Claim a settled position owned by the configured operator wallet.',
    inputSchema: { basketId: z.string().min(1) },
  },
  async ({ basketId }) => text(await claimWithOperator(basketId)),
);

server.registerTool(
  'list_baskets',
  {
    description: 'List every basket stored by the deployed escrow program.',
    inputSchema: {},
  },
  async () => text({ escrow: escrowInfo, baskets: await listBaskets() }),
);

server.registerTool(
  'get_wallet_positions',
  {
    description: 'List all on-chain escrow positions owned by a Solana wallet.',
    inputSchema: { owner: z.string().min(32) },
  },
  async ({ owner }) => text(await getWalletPositions(owner)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
