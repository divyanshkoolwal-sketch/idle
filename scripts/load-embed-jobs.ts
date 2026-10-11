/**
 * P1 acceptance load: posts N embed jobs concurrently (PAYMENTS=off), retries like an agent would on
 * 503 NO_CAPACITY / 409 NO_ACCEPTABLE_BID, then checks second-price clearing and a cosine sample.
 *   pnpm tsx scripts/load-embed-jobs.ts --n 60 [--concurrency 6] [--verify 5] [--exchange http://localhost:8080]
 */
import { randomUUID } from 'node:crypto';
import { loadEnv, REPO_ROOT, cosine } from '@idle/shared';
import type { AuctionView, JobResult } from '@idle/shared';
import { sentences } from '../apps/exchange/src/corpus';
import { ollamaEmbed } from '../apps/exchange/src/reference';
import { arg, banner, ok, info, fail } from './_lib';

loadEnv(REPO_ROOT);
const N = Number(arg('n') ?? 60);
const CONC = Number(arg('concurrency') ?? 6);
const VERIFY = Number(arg('verify') ?? 5);
const EX = (arg('exchange') ?? process.env.EXCHANGE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'nomic-embed-text';
const PRICE_CAP = 60n;

interface Done {
  i: number;
  persona: string;
  texts: string[];
  result: JobResult;
  wallMs: number;
  attempts: number;
  maxUnitPrice: bigint;
}
const done: Done[] = [];
const failed: { i: number; reason: string }[] = [];
let retries503 = 0;
let retries409 = 0;
let retries502 = 0;

async function submit(i: number): Promise<void> {
  const rng = () => Math.random();
  const texts = sentences(8 + Math.floor(rng() * 25), 1000 + i);
  const persona = i % 2 ? 'analyst' : 'indexer';
  let maxUnitPrice = BigInt(10 + Math.floor(rng() * 31));
  const deadlineMs = 3000 + Math.floor(rng() * 17000);
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 10; attempt++) {
    const res = await fetch(`${EX}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ jobType: 'embed', input: { texts }, maxUnitPrice: maxUnitPrice.toString(), deadlineMs, persona, agentId: `load-${persona}` }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) {
      done.push({ i, persona, texts, result: body as unknown as JobResult, wallMs: Date.now() - t0, attempts: attempt, maxUnitPrice });
      return;
    }
    if (res.status === 503) {
      retries503++;
      await new Promise((r) => setTimeout(r, Number(body.retryAfterMs ?? 2000) * (0.5 + rng())));
      continue;
    }
    if (res.status === 409) {
      retries409++;
      const suggested = body.suggestedMaxUnitPrice ? BigInt(String(body.suggestedMaxUnitPrice)) : maxUnitPrice + 5n;
      const next = suggested > PRICE_CAP ? PRICE_CAP : suggested;
      if (next <= maxUnitPrice) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      maxUnitPrice = next;
      continue;
    }
    if (res.status === 502) {
      retries502++;
      info(`job ${i}: 502 ${body.error} (${body.message ?? ''}) — re-auctioning`);
      continue;
    }
    failed.push({ i, reason: `${res.status} ${JSON.stringify(body).slice(0, 160)}` });
    return;
  }
  failed.push({ i, reason: 'gave up after 10 attempts' });
}

async function pool(n: number, c: number, fn: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: c }, async () => {
    while (next < n) {
      const i = next++;
      await fn(i);
    }
  });
  await Promise.all(workers);
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function main() {
  banner(`load: ${N} embed jobs → ${EX} (concurrency ${CONC})`);
  const health = await fetch(`${EX}/v1/health`).then((r) => r.json() as Promise<{ stats: { providersVerified: number }; payments: string }>);
  info(`providers verified: ${health.stats.providersVerified}  payments=${health.payments}`);
  if (health.payments !== 'off') fail('this load script needs PAYMENTS=off');
  const t0 = Date.now();
  await pool(N, CONC, submit);
  const wall = Date.now() - t0;
  ok(`${done.length}/${N} jobs completed in ${(wall / 1000).toFixed(1)} s  (retries: 503×${retries503}, 409×${retries409}, 502×${retries502}; failed ${failed.length})`);
  for (const f of failed.slice(0, 5)) info(`failed job ${f.i}: ${f.reason}`);

  // winners + latency
  const byWinner = new Map<string, number>();
  for (const d of done) byWinner.set(d.result.providerName, (byWinner.get(d.result.providerName) ?? 0) + 1);
  info(`winners: ${[...byWinner].map(([k, v]) => `${k}=${v}`).join('  ')}`);
  const lat = done.map((d) => d.result.latencyMs);
  const wallMs = done.map((d) => d.wallMs);
  info(`provider latency p50 ${pct(lat, 50)} ms  p95 ${pct(lat, 95)} ms   |   end-to-end (incl. retries) p50 ${pct(wallMs, 50)} ms  p95 ${pct(wallMs, 95)} ms`);
  const sampled = done.filter((d) => d.result.verification.sampled);
  info(`spot checks: ${sampled.length} sampled, ${sampled.filter((d) => d.result.verification.passed).length} passed`);

  // second-price rule on the auctions we won
  const auctions = (await fetch(`${EX}/v1/auctions?limit=500`).then((r) => r.json())) as AuctionView[];
  const ours = new Map(done.map((d) => [d.result.auctionId, d]));
  let checked = 0;
  let holds = 0;
  const prices: bigint[] = [];
  for (const a of auctions) {
    const d = ours.get(a.id);
    if (!d || a.status !== 'cleared' || !a.clearingUnitPrice) continue;
    checked++;
    const valid = a.bids.filter((b) => b.valid).map((b) => BigInt(b.unitPrice)).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const expected = valid.length >= 2 ? (valid[1] < d.maxUnitPrice ? valid[1] : d.maxUnitPrice) : valid[0];
    const clearing = BigInt(a.clearingUnitPrice);
    prices.push(clearing);
    const okRule = clearing === expected && clearing <= d.maxUnitPrice;
    if (okRule) holds++;
    else info(`auction ${a.id}: clearing ${clearing} expected ${expected} (bids ${a.bids.map((b) => `${b.providerName}:${b.unitPrice}${b.valid ? '' : '✗'}`).join(', ')} max ${d.maxUnitPrice})`);
  }
  const avg = prices.length ? prices.reduce((a, b) => a + b, 0n) / BigInt(prices.length) : 0n;
  info(`clearing prices: min ${prices.length ? prices.reduce((a, b) => (b < a ? b : a)) : '-'}  avg ${avg}  max ${prices.length ? prices.reduce((a, b) => (b > a ? b : a)) : '-'}  (atomic AUSD per text)`);
  for (const a of auctions.filter((x) => ours.has(x.id)).slice(0, 8)) {
    info(`  ${a.id} ${a.persona?.padEnd(7)} ${String(a.units).padStart(2)} texts  bids[${a.bids.map((b) => `${b.providerName}:${b.unitPrice}${b.valid ? '' : '✗'}`).join(' ')}]  → ${a.winnerName} pays 2nd price ${a.clearingUnitPrice}`);
  }
  if (holds === checked) ok(`second-price rule holds for ${holds}/${checked} cleared auctions`);
  else info(`second-price rule violated in ${checked - holds}/${checked} auctions`);

  // cosine sample against local Ollama
  const sample = [...done].sort(() => Math.random() - 0.5).slice(0, VERIFY);
  let verifyOk = 0;
  for (const d of sample) {
    const ref = await ollamaEmbed(OLLAMA, EMBED_MODEL, d.texts);
    const embs = d.result.output.embeddings ?? [];
    const min = Math.min(...d.texts.map((_, k) => cosine(embs[k] ?? [], ref[k])));
    const pass = min >= 0.995;
    if (pass) verifyOk++;
    info(`verify job ${d.result.jobId} (${d.result.providerName}, ${d.texts.length} texts): min cosine ${min.toFixed(5)} ${pass ? '✔' : '✘'}`);
  }
  const completion = done.length / N;
  if (verifyOk === sample.length) ok(`cosine sample ${verifyOk}/${sample.length} ≥ 0.995`);
  if (completion < 0.9 || verifyOk !== sample.length || holds !== checked) fail('acceptance failed');
  ok('acceptance passed');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
