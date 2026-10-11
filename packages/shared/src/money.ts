/**
 * All money is bigint in atomic units: AUSD atomic (10^-decimals) and XRP drops.
 * Never use floats for money.
 */
export const DROPS_PER_XRP = 1_000_000n;

export function parseUnits(value: string, decimals: number): bigint {
  const [whole, frac = ''] = value.trim().split('.');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) throw new Error(`Bad decimal string: ${value}`);
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

export function formatUnits(amount: bigint, decimals: number, maxFractionDigits = decimals): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFractionDigits);
  frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export const xrpToDrops = (xrp: string): bigint => parseUnits(xrp, 6);
export const dropsToXrp = (drops: bigint): string => formatUnits(drops, 6);

/** Multiply a unit price by a unit count, both bigint. */
export const mul = (unitPrice: bigint, units: number | bigint): bigint => unitPrice * BigInt(units);

export function maxBig(a: bigint, b: bigint): bigint { return a > b ? a : b; }
export function minBig(a: bigint, b: bigint): bigint { return a < b ? a : b; }
