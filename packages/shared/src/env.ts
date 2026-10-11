import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repo root (packages/shared/src -> ../../..). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Loads `<root>/.env` (shared defaults) and then `<appDir>/.env.local` (per-app overrides).
 * Secrets live only in these gitignored files.
 */
export function loadEnv(appDir?: string): void {
  const rootEnv = path.join(REPO_ROOT, '.env');
  if (existsSync(rootEnv)) config({ path: rootEnv });
  if (appDir) {
    const local = path.join(appDir, '.env.local');
    if (existsSync(local)) config({ path: local, override: true });
  }
}

export function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

export function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
