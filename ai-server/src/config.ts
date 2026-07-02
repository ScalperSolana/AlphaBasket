import 'dotenv/config';
import { readFileSync } from 'node:fs';

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(optional(name) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function operatorSecret(): string | undefined {
  const inline = optional('AI_OPERATOR_KEYPAIR');
  const file = optional('AI_OPERATOR_KEYPAIR_FILE');
  if (inline && file) {
    throw new Error('Set only one of AI_OPERATOR_KEYPAIR or AI_OPERATOR_KEYPAIR_FILE');
  }
  return file ? readFileSync(file, 'utf8').trim() : inline;
}

export const config = {
  port: positiveNumber('AI_SERVER_PORT', 4370),
  rpcUrl: optional('AI_SOLANA_RPC_URL') ?? optional('SOLANA_RPC_URL') ?? 'https://api.devnet.solana.com',
  cluster: optional('AI_SOLANA_CLUSTER') ?? 'devnet',
  usdcMint: optional('AI_USDC_MINT') ?? 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
  quoteApiUrl: (optional('AI_QUOTE_API_URL') ?? 'http://127.0.0.1:4360').replace(/\/+$/, ''),
  operatorSecret: operatorSecret(),
  gammaBaseUrl: (optional('POLYMARKET_GAMMA_BASE_URL') ?? 'https://gamma-api.polymarket.com').replace(/\/+$/, ''),
  geminiApiKey: optional('GEMINI_API_KEY'),
  geminiModel: optional('GEMINI_MODEL') ?? 'gemini-2.5-flash-lite',
  backboardApiKey: optional('BACKBOARD_API_KEY'),
  backboardAssistantId: optional('THESIS_RESEARCHER_ASSISTANT_ID'),
  writeApiKey: optional('AI_WRITE_API_KEY'),
  allowedOrigins: (optional('AI_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

export function requireOperatorSecret(): string {
  if (!config.operatorSecret) {
    throw new Error('AI operator wallet is not configured. Set AI_OPERATOR_KEYPAIR or AI_OPERATOR_KEYPAIR_FILE.');
  }
  return config.operatorSecret;
}
