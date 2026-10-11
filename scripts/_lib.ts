/* Shared helpers for setup + smoke scripts. */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '@idle/shared';

export const ROOT_ENV = path.join(REPO_ROOT, '.env');
export const PROVIDER_ENV = path.join(REPO_ROOT, 'apps/provider/.env.local');

export function ensureEnvFiles(): void {
  if (!existsSync(ROOT_ENV)) {
    copyFileSync(path.join(REPO_ROOT, '.env.example'), ROOT_ENV);
    console.log(`created ${rel(ROOT_ENV)} from .env.example`);
  }
  if (!existsSync(PROVIDER_ENV)) {
    writeFileSync(PROVIDER_ENV, '# per-laptop provider overrides (gitignored)\n');
    console.log(`created ${rel(PROVIDER_ENV)}`);
  }
}

export function readEnvValue(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] === key) {
      const v = m[2].replace(/(^|\s+)#.*$/, '').trim();
      return v === '' ? undefined : v;
    }
  }
  return undefined;
}

/**
 * Sets KEY=value in an env file. Never overwrites a non-empty value unless `overwrite` is true.
 * Keeps inline comments on the line. Returns true if the file changed.
 */
export function upsertEnv(file: string, key: string, value: string, overwrite = false): boolean {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  let changed = false;
  let found = false;
  const out = lines.map((line) => {
    const m = line.match(/^(\s*)([A-Z0-9_]+)(\s*=\s*)([^#]*?)(\s*#.*)?$/);
    if (!m || m[2] !== key) return line;
    found = true;
    const current = m[4].trim();
    if (current !== '' && !overwrite) return line;
    if (current === value) return line;
    changed = true;
    const comment = m[5] ? m[5] : '';
    return `${key}=${value}${comment ? ' ' + comment.trim() : ''}`;
  });
  if (!found) {
    out.push(`${key}=${value}`);
    changed = true;
  }
  if (changed) writeFileSync(file, out.join('\n').replace(/\n*$/, '\n'));
  return changed;
}

export const rel = (p: string) => path.relative(REPO_ROOT, p);

export function banner(title: string): void {
  console.log(`\n\x1b[1m== ${title} ==\x1b[0m`);
}
export function ok(msg: string): void {
  console.log(`\x1b[32m✔\x1b[0m ${msg}`);
}
export function fail(msg: string): never {
  console.error(`\x1b[31m✘\x1b[0m ${msg}`);
  process.exit(1);
}
export function info(msg: string): void {
  console.log(`  ${msg}`);
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return process.argv[i + 1] ?? 'true';
}
export const hasFlag = (name: string) => process.argv.includes(`--${name}`);
