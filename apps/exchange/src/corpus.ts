/** Deterministic pseudo-random sentences for burst load and tests (no network, no model). */
const SUBJECTS = ['The exchange', 'A buyer agent', 'Each data center', 'The relayer', 'An idle laptop', 'The verifier', 'A payment channel', 'The auction', 'The indexer', 'Our facilitator'];
const VERBS = ['clears', 'prices', 'settles', 'verifies', 'streams', 'embeds', 'reserves', 'revokes', 'benchmarks', 'quotes'];
const OBJECTS = ['a batch of embeddings', 'the second-price bid', 'tokens per second', 'a signed claim', 'the credential on-ledger', 'spare GPU minutes', 'a sealed bid', 'the golden set', 'a cheap generation', 'the spot check'];
const TAILS = ['before the deadline.', 'in about a quarter of a second.', 'without an account.', 'while the market is busy.', 'when the lid closes.', 'after the work passes verification.', 'for exactly the tokens delivered.', 'on Base Sepolia.', 'over the XRPL testnet.', 'with no hard-coded prices.'];

export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

export function sentence(rng: () => number): string {
  const pick = (a: string[]) => a[Math.floor(rng() * a.length)];
  return `${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)} ${pick(TAILS)}`;
}

export function sentences(n: number, seed = Date.now()): string[] {
  const rng = makeRng(seed);
  return Array.from({ length: n }, (_, i) => `${sentence(rng)} (#${seed % 1000}-${i})`);
}
