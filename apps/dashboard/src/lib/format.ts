import type { JobType, Currency } from '@shared/protocol';

/** Fixed-decimal formatting of an atomic bigint amount (never floats for money). */
export function fixed(atomic: string | bigint | number, decimals: number, dp: number): string {
  let v: bigint;
  try {
    v = typeof atomic === 'bigint' ? atomic : BigInt(String(atomic || '0'));
  } catch {
    return '—';
  }
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').slice(0, dp);
  const wholeStr = whole.toLocaleString('en-US');
  return `${neg ? '-' : ''}${wholeStr}${dp > 0 ? '.' + frac : ''}`;
}

export const ausd = (atomic: string | bigint, dp = 4) => fixed(atomic, 6, dp);
export const xrp = (drops: string | bigint, dp = 3) => fixed(drops, 6, dp);

/** Per-unit price: atomic AUSD shown as µAUSD, drops as drops. */
export const unitPrice = (atomic: string) => Number(atomic).toLocaleString('en-US');
export const unitSymbol = (currency: Currency) => (currency === 'XRP' ? 'drops' : 'µAUSD');
export const perUnit = (jobType: JobType) => (jobType === 'embed' ? 'text' : 'token');

export const shortHash = (h: string, n = 6) => (h.length > n * 2 + 2 ? `${h.slice(0, n + (h.startsWith('0x') ? 2 : 0))}…${h.slice(-4)}` : h);

export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} s` : `${Math.round(n)} ms`);

export const jobLabel = (jobType: JobType, units: number) =>
  jobType === 'embed' ? `embed · ${units} texts` : jobType === 'generate' ? `generate · ${units} tokens` : `stream · up to ${units} tokens`;

const REASONS: Record<string, string> = {
  above_max_unit_price: 'above max price',
  above_max: 'above max price',
  eta_exceeds_deadline: 'too slow for the deadline',
  too_slow: 'too slow for the deadline',
  no_capacity: 'no free slots',
  not_verified: 'not verified',
  below_tier: 'below the required tier',
  no_free_slots: 'no free slots',
};
export const humanReason = (r?: string): string | undefined => (r ? (REASONS[r] ?? r.replace(/_/g, ' ')) : undefined);
