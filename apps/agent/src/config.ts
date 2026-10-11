import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, env, parseUnits } from '@idle/shared';
import type { Hex } from 'viem';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(APP_DIR);

export const cfg = {
  exchangeUrl: (process.env.EXCHANGE_URL ?? 'http://localhost:8080').replace(/\/+$/, ''),
  model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
  effort: (process.env.ANTHROPIC_EFFORT ?? 'medium') as 'low' | 'medium' | 'high',
  budgetAusd: parseUnits(process.env.AGENT_BUDGET_AUSD ?? '5', 6),
  budgetDrops: parseUnits(process.env.AGENT_BUDGET_XRP ?? '20', 6),
  evmKey: () => env('AGENT_EVM_PRIVATE_KEY') as Hex,
  xrplSeed: () => env('AGENT_XRPL_SEED'),
  embedModel: process.env.EMBED_MODEL ?? 'nomic-embed-text',
  genModel: process.env.GEN_MODEL ?? 'llama3.2:3b',
};
