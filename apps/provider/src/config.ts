import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, envBool, envInt, loadEnv } from '@idle/shared';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_LOCAL = path.join(APP_DIR, '.env.local');

export interface Floors {
  embed: bigint; // AUSD atomic per text
  generate: bigint; // AUSD atomic per token
  streamDrops: bigint; // XRP drops per delivered token
}

export interface ProviderConfig {
  name: string;
  region: string;
  slots: number;
  floors: Floors;
  ollamaUrl: string;
  embedModel: string;
  genModel: string;
  cheat: boolean;
  /** Sampling temperature for generation. Default 0 (greedy): Ollama 0.34's Metal sampler degenerates at T>0 on Apple Silicon. */
  genTemperature: number;
  /** auto (probe at startup), gpu, or cpu. */
  genDevice: 'auto' | 'gpu' | 'cpu';
  embedDevice: 'auto' | 'gpu' | 'cpu';
  exchangeUrl: string;
  /** Wall-clock budget for the startup benchmark; skip it with --no-benchmark (uses defaults). */
  benchmark: boolean;
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const device = (v: string): 'auto' | 'gpu' | 'cpu' => (v === 'gpu' || v === 'cpu' ? v : 'auto');

function parseAtomic(v: string, name: string): bigint {
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer (atomic units), got "${v}"`);
  return BigInt(v);
}

export function loadConfig(argv = process.argv.slice(2)): ProviderConfig {
  loadEnv(APP_DIR);
  const args = parseArgs(argv);
  const str = (flag: string, key: string, fallback: string) => (typeof args[flag] === 'string' ? (args[flag] as string) : env(key, fallback));
  const slots = Number(typeof args.slots === 'string' ? args.slots : envInt('PROVIDER_SLOTS', 2));
  if (!Number.isInteger(slots) || slots < 1) throw new Error('slots must be a positive integer');
  const cheat = args.cheat === true || args.cheat === 'true' || (args.cheat === undefined && envBool('CHEAT', false));
  return {
    name: str('name', 'PROVIDER_NAME', 'DC-Local-1'),
    region: str('region', 'PROVIDER_REGION', 'local'),
    slots,
    floors: {
      embed: parseAtomic(env('FLOOR_EMBED_AUSD_PER_TEXT', '15'), 'FLOOR_EMBED_AUSD_PER_TEXT'),
      generate: parseAtomic(env('FLOOR_GEN_AUSD_PER_TOKEN', '25'), 'FLOOR_GEN_AUSD_PER_TOKEN'),
      streamDrops: parseAtomic(env('FLOOR_GEN_DROPS_PER_TOKEN', '40'), 'FLOOR_GEN_DROPS_PER_TOKEN'),
    },
    ollamaUrl: env('OLLAMA_URL', 'http://localhost:11434').replace(/\/+$/, ''),
    embedModel: env('EMBED_MODEL', 'nomic-embed-text'),
    genModel: env('GEN_MODEL', 'llama3.2:3b'),
    cheat,
    genTemperature: Number(env('GEN_TEMPERATURE', '0')),
    genDevice: device(env('GEN_DEVICE', 'auto')),
    embedDevice: device(env('EMBED_DEVICE', 'auto')),
    exchangeUrl: str('exchange', 'EXCHANGE_URL', 'http://localhost:8080').replace(/\/+$/, ''),
    benchmark: args['no-benchmark'] !== true,
  };
}
