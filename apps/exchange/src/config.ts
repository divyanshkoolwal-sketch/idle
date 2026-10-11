import path from 'node:path';
import { envInt, envBool } from '@idle/shared';

export interface Config {
  appDir: string;
  port: number;
  exchangeUrl: string;
  dbPath: string;
  ollamaUrl: string;
  embedModel: string;
  genModel: string;
  rfqWindowMs: number;
  quoteTtlMs: number;
  spotcheckRate: number;
  strikesToRevoke: number;
  payments: 'on' | 'off';
  credentials: 'on' | 'off';
  verifyCosine: number;
  challengeTimeoutMs: number;
  tierAEmbedTps: number;
  tierAGenTps: number;
  heartbeatTimeoutMs: number;
  adminToken: string;
  recordEvents: boolean;
  dashboardDist: string;
  resultGraceMs: number;
}

export function loadConfig(appDir: string): Config {
  const repoRoot = path.resolve(appDir, '../..');
  return {
    appDir,
    port: envInt('EXCHANGE_PORT', 8080),
    exchangeUrl: process.env.EXCHANGE_URL || `http://localhost:${envInt('EXCHANGE_PORT', 8080)}`,
    dbPath: process.env.DB_PATH || path.join(repoRoot, 'data', 'idle.db'),
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    embedModel: process.env.EMBED_MODEL || 'nomic-embed-text',
    genModel: process.env.GEN_MODEL || 'llama3.2:3b',
    rfqWindowMs: envInt('RFQ_WINDOW_MS', 250),
    quoteTtlMs: envInt('QUOTE_TTL_MS', 15_000),
    spotcheckRate: Number(process.env.SPOTCHECK_RATE ?? '0.2'),
    strikesToRevoke: envInt('STRIKES_TO_REVOKE', 2),
    payments: (process.env.PAYMENTS ?? 'on').toLowerCase() === 'off' ? 'off' : 'on',
    credentials: (process.env.CREDENTIALS ?? 'on').toLowerCase() === 'off' ? 'off' : 'on',
    verifyCosine: Number(process.env.VERIFY_COSINE ?? '0.995'),
    challengeTimeoutMs: envInt('CHALLENGE_TIMEOUT_MS', 10_000),
    tierAEmbedTps: Number(process.env.TIER_A_EMBED_TPS ?? '40'),
    tierAGenTps: Number(process.env.TIER_A_GEN_TPS ?? '15'),
    heartbeatTimeoutMs: envInt('HEARTBEAT_TIMEOUT_MS', 5_000),
    adminToken: process.env.ADMIN_TOKEN || '',
    recordEvents: envBool('RECORD_EVENTS', false),
    dashboardDist: path.join(repoRoot, 'apps', 'dashboard', 'dist'),
    resultGraceMs: envInt('RESULT_GRACE_MS', 20_000),
  };
}
