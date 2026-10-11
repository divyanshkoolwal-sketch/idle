import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** Reads KEY from a dotenv-style file; a line whose value is only a comment counts as empty. */
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

/** Sets KEY=value, never overwriting a non-empty value. Returns true if the file changed. */
export function upsertEnv(file: string, key: string, value: string): boolean {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  let changed = false;
  let found = false;
  const out = lines.map((line) => {
    const m = line.match(/^(\s*)([A-Z0-9_]+)(\s*=\s*)([^#]*?)(\s*#.*)?$/);
    if (!m || m[2] !== key) return line;
    found = true;
    if (m[4].trim() !== '') return line;
    changed = true;
    return `${key}=${value}${m[5] ? ' ' + m[5].trim() : ''}`;
  });
  if (!found) {
    out.push(`${key}=${value}`);
    changed = true;
  }
  if (changed) writeFileSync(file, out.join('\n').replace(/\n*$/, '\n'));
  return changed;
}
