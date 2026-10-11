/** Cosine similarity for verification. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Golden set used for onboarding challenges and spot checks (fixed on purpose). */
export const GOLDEN_TEXTS = [
  'A payment channel lets two parties exchange signed claims off-ledger and settle once.',
  'The GPU shortage pushed inference prices up for the third week in a row.',
  'Sealed-bid second-price auctions reward bidders for telling the truth about their costs.',
  'Berkeley fog rolls over the bay most summer mornings before burning off by noon.',
  'An embedding maps a sentence to a point in a high-dimensional space.',
  'Stablecoins settle in seconds, but gas still has to be paid by someone.',
  'Idle laptops are data centers that nobody rents by the hour.',
  'Verification by re-execution is cheap when the work is deterministic.',
] as const;
