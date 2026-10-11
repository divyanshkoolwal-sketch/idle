/**
 * Generates public/replay/demo.jsonl — a ~90 s typed story for the dashboard's replay mode.
 * Run: pnpm --filter @idle/dashboard make-replay
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DashboardEvent, ProviderView, AuctionView, BidView, JobView, PaymentView, AgentLog, MarketStats, JobType, Currency } from '../../../packages/shared/src/protocol';

// deterministic PRNG so the file is reproducible
let seed = 0x1d1e5eed;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hex = (n: number, upper = false) => {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(rnd() * 16).toString(16);
  return upper ? s.toUpperCase() : s;
};
const evmTx = () => '0x' + hex(64);
const xrplTx = () => hex(64, true);
const jitter = (x: number, pct: number) => x * (1 + (rnd() * 2 - 1) * pct);

const T0 = Date.UTC(2026, 9, 11, 21, 0, 0); // fixed base; replay uses relative timing
const frames: DashboardEvent[] = [];
type Frame = DashboardEvent extends infer U ? (U extends { ts: number } ? Omit<U, 'ts'> : never) : never;
const emit = (tMs: number, ev: Frame) => frames.push(structuredClone({ ...ev, ts: T0 + Math.round(tMs) }) as DashboardEvent);

const ISSUER = 'rM6wXjEPCMByRWfrb61WEcWmzkCTwLkiZ';
const BUYER_XRPL = 'rJU8PHoE7MCxm51kGe4iEbnzS8M7K92F9g';
const BUYER_EVM = '0xF7465a0EA04f1149d84675e083aA44EB14B80191';

type P = ProviderView & { floorsN: { embed: number; generate: number; streamDrops: number }; wins: number; auctions: number };
const mkProvider = (o: { id: string; name: string; region: string; chip: string; ramGb: number; floors: { embed: number; generate: number; streamDrops: number }; evm: string; xrpl: string; tier: 'A' | 'B'; embedTps: number; genTps: number; slots: number }): P => ({
  id: o.id,
  name: o.name,
  region: o.region,
  hardware: { cpu: o.chip, chip: o.chip, ramGb: o.ramGb, label: `${o.chip} · ${o.ramGb} GB` },
  evmAddress: o.evm,
  xrplAddress: o.xrpl,
  models: ['nomic-embed-text', 'llama3.2:3b'],
  slots: o.slots,
  busySlots: 0,
  queueDepth: 0,
  benchmark: { embedTps: o.embedTps, genTps: o.genTps, embedMs: Math.round(64000 / o.embedTps), genMs: Math.round(128000 / o.genTps) },
  tier: undefined,
  status: 'pending',
  strikes: 0,
  shade: 1,
  surge: 1,
  asks: { embed: String(o.floors.embed), generate: String(o.floors.generate), stream: String(o.floors.streamDrops) },
  floors: { embed: String(o.floors.embed), generate: String(o.floors.generate), streamDrops: String(o.floors.streamDrops) },
  credential: undefined,
  earnings: { ausd: '0', drops: '0' },
  jobsDone: 0,
  cheat: false,
  draining: false,
  online: true,
  lastSeen: T0,
  floorsN: o.floors,
  wins: 0,
  auctions: 0,
});

const providers: P[] = [
  mkProvider({ id: 'dc-berkeley-1', name: 'DC-Berkeley-1', region: 'us-west · Berkeley', chip: 'Apple M3 Pro', ramGb: 18, floors: { embed: 15, generate: 25, streamDrops: 40 }, evm: '0xD7c4DF726d6c91Cd5e2E9F554aF503aC848Fc909', xrpl: 'rp4QDnTgcuNTYxri5uMiwnzMUbXvLn4uSe', tier: 'A', embedTps: 61, genTps: 48, slots: 2 }),
  mkProvider({ id: 'dc-oakland-2', name: 'DC-Oakland-2', region: 'us-west · Oakland', chip: 'Apple M2', ramGb: 16, floors: { embed: 10, generate: 20, streamDrops: 30 }, evm: '0x3a9F1c0E2b7D4a5C6e8F9A0b1C2d3E4f5A6b7C8d', xrpl: 'rwVJ6k2p1Q8m3L5n7H9t4B2c6D8e0F1gXy', tier: 'B', embedTps: 34, genTps: 22, slots: 2 }),
  mkProvider({ id: 'dc-sf-3', name: 'DC-SF-3', region: 'us-west · San Francisco', chip: 'Apple M4 Max', ramGb: 36, floors: { embed: 18, generate: 28, streamDrops: 45 }, evm: '0x9b2E4c6A8d0F1e3B5c7D9a1C3e5F7b9D1a3C5e7F', xrpl: 'rK4m8N2p6Q0s4U8w2Y6a0C4e8G2i6K0mZq', tier: 'A', embedTps: 88, genTps: 71, slots: 3 }),
];
const byId = Object.fromEntries(providers.map((p) => [p.id, p]));

const stats: MarketStats = { jobsCleared: 0, ausdSettled: '0', dropsStreamed: '0', providersOnline: 0, providersVerified: 0, slotsTotal: 0, slotsBusy: 0, clearing: {} };
const addAtomic = (a: string, b: string | number) => (BigInt(a) + BigInt(b)).toString();

const view = (p: P): ProviderView => {
  const { floorsN: _f, wins: _w, auctions: _a, ...v } = p;
  return { ...v, earnings: { ...p.earnings }, asks: { ...p.asks }, credential: p.credential ? { ...p.credential } : undefined };
};
const surgeOf = (p: P) => 1 + 1.5 * Math.pow(p.busySlots / p.slots, 2);
const asksOf = (p: P) => ({
  embed: String(Math.round(p.floorsN.embed * surgeOf(p) * p.shade)),
  generate: String(Math.round(p.floorsN.generate * surgeOf(p) * p.shade)),
  stream: String(Math.round(p.floorsN.streamDrops * surgeOf(p) * p.shade)),
});
const util = (t: number, p: P) => {
  p.surge = surgeOf(p);
  p.asks = asksOf(p);
  p.lastSeen = T0 + t;
  emit(t, { type: 'provider.util', providerId: p.id, busySlots: p.busySlots, slots: p.slots, queueDepth: p.queueDepth, shade: p.shade, surge: p.surge, asks: p.asks, draining: p.draining, cheat: p.cheat });
};
const log = (t: number, persona: 'analyst' | 'indexer', kind: AgentLog['kind'], text: string, meta?: Record<string, unknown>) =>
  emit(t, { type: 'agent.log', log: { agentId: `agent-${persona}`, persona, kind, text, ts: T0 + Math.round(t), meta } });
const pushStats = (t: number) => {
  const online = providers.filter((p) => p.online && p.status !== 'suspended');
  stats.providersOnline = online.length;
  stats.providersVerified = online.filter((p) => p.status === 'verified').length;
  stats.slotsTotal = online.filter((p) => p.status === 'verified').reduce((n, p) => n + p.slots, 0);
  stats.slotsBusy = online.reduce((n, p) => n + p.busySlots, 0);
  emit(t, { type: 'stats', stats: { ...stats, clearing: { ...stats.clearing } } });
};

// ---------- t = 0: empty snapshot ----------
emit(0, { type: 'snapshot', providers: [], auctions: [], payments: [], jobs: [], stats: { ...stats }, prices: [], logs: [], issuer: ISSUER });

// ---------- onboarding ----------
providers.forEach((p, i) => {
  const t = 600 + i * 1400;
  emit(t, { type: 'provider.online', provider: view(p) });
  const issue = xrplTx();
  const accept = xrplTx();
  const tier = (['A', 'B', 'A'] as const)[i];
  emit(t + 900, { type: 'credential.issued', providerId: p.id, providerName: p.name, txHash: issue, credentialType: `IDLE_DC_TIER_${tier}`, tier });
  emit(t + 2100, { type: 'credential.accepted', providerId: p.id, providerName: p.name, txHash: accept });
  p.tier = tier;
  p.status = 'verified';
  p.credential = { type: `IDLE_DC_TIER_${tier}`, issueTx: issue, acceptTx: accept, status: 'accepted' };
  emit(t + 2150, { type: 'provider.verified', providerId: p.id, tier, credential: { type: `IDLE_DC_TIER_${tier}`, issueTx: issue, acceptTx: accept } });
  util(t + 2200, p);
});
pushStats(5200);

// ---------- auction simulation ----------
let auctionN = 0;
let jobN = 0;
interface AuctionOpts {
  jobType: Exclude<JobType, 'stream'>;
  units: number;
  persona: 'analyst' | 'indexer';
  maxUnitPrice: number;
  deadlineMs: number;
  sampled?: boolean;
}
const settledPayments: PaymentView[] = [];

function runAuction(t: number, o: AuctionOpts): { winner?: P; clearing?: number; done: number } {
  auctionN += 1;
  const id = `auc-${String(auctionN).padStart(3, '0')}`;
  const currency: Currency = 'AUSD';
  const eligible = providers.filter((p) => p.online && p.status === 'verified' && !p.draining && p.busySlots < p.slots);
  const auction: AuctionView = {
    id,
    jobType: o.jobType,
    model: o.jobType === 'embed' ? 'nomic-embed-text' : 'llama3.2:3b',
    units: o.units,
    currency,
    maxUnitPrice: String(o.maxUnitPrice),
    deadlineMs: o.deadlineMs,
    persona: o.persona,
    agentId: `agent-${o.persona}`,
    openedAt: T0 + Math.round(t),
    status: 'open',
    bids: [],
  };
  emit(t, { type: 'auction.opened', auction: { ...auction } });
  if (eligible.length === 0) {
    const failed: AuctionView = { ...auction, status: 'no_bids', closedAt: T0 + Math.round(t + 260) };
    emit(t + 260, { type: 'auction.failed', auction: failed, reason: 'no capacity' });
    return { done: t + 260 };
  }
  const bids: BidView[] = [];
  eligible.forEach((p, i) => {
    p.auctions += 1;
    const floor = o.jobType === 'embed' ? p.floorsN.embed : p.floorsN.generate;
    const cheatFactor = p.cheat ? 0.6 : 1;
    const price = Math.max(1, Math.round(jitter(floor * surgeOf(p) * p.shade * cheatFactor, 0.03)));
    const tps = o.jobType === 'embed' ? p.benchmark.embedTps : p.benchmark.genTps;
    const eta = Math.round(150 + p.queueDepth * 900 + (o.units / tps) * 1000);
    const valid = price <= o.maxUnitPrice && eta <= o.deadlineMs;
    const bid: BidView = { providerId: p.id, providerName: p.name, unitPrice: String(price), etaMs: eta, shade: p.shade, surge: surgeOf(p), valid, reason: valid ? undefined : price > o.maxUnitPrice ? `above max ${o.maxUnitPrice}` : 'too slow for deadline', receivedAt: T0 + Math.round(t + 40 + i * 55) };
    bids.push(bid);
    emit(t + 40 + i * 55, { type: 'auction.bid', auctionId: id, bid });
  });
  const valid = bids.filter((b) => b.valid).sort((a, b) => Number(a.unitPrice) - Number(b.unitPrice) || a.etaMs - b.etaMs);
  const closedAt = t + 270;
  if (valid.length === 0) {
    const best = [...bids].sort((a, b) => Number(a.unitPrice) - Number(b.unitPrice))[0];
    const failed: AuctionView = { ...auction, bids, status: 'no_acceptable_bid', closedAt: T0 + Math.round(closedAt) };
    emit(closedAt, { type: 'auction.failed', auction: failed, reason: `best bid ${best.unitPrice} above max ${o.maxUnitPrice}` });
    return { done: closedAt };
  }
  const winner = byId[valid[0].providerId];
  const clearing = valid.length >= 2 ? Math.min(Number(valid[1].unitPrice), o.maxUnitPrice) : Number(valid[0].unitPrice);
  winner.wins += 1;
  for (const p of eligible) {
    // learn from the last few auctions
    const winRate = p.wins / Math.max(1, p.auctions);
    if (p.auctions >= 3) {
      if (winRate < 0.3) p.shade = Math.max(1, p.shade * 0.95);
      else if (winRate > 0.6) p.shade = Math.min(1.6, p.shade * 1.05);
    }
  }
  const cleared: AuctionView = { ...auction, bids, status: 'cleared', closedAt: T0 + Math.round(closedAt), winnerProviderId: winner.id, winnerName: winner.name, clearingUnitPrice: String(clearing) };
  emit(closedAt, { type: 'auction.cleared', auction: cleared });
  stats.jobsCleared += 1;
  stats.clearing[o.jobType] = String(clearing);
  emit(closedAt + 5, { type: 'price.tick', tick: { jobType: o.jobType, currency, unitPrice: String(clearing), ts: T0 + Math.round(closedAt + 5), demand: 1, supply: eligible.length } });

  // dispatch + run
  jobN += 1;
  const jobId = `job-${String(jobN).padStart(3, '0')}`;
  const amount = clearing * o.units;
  const job: JobView = { id: jobId, auctionId: id, agentId: `agent-${o.persona}`, persona: o.persona, jobType: o.jobType, model: auction.model, units: o.units, rail: 'x402', status: 'running', providerId: winner.id, providerName: winner.name, unitPrice: String(clearing), amount: String(amount), currency, createdAt: T0 + Math.round(closedAt + 40) };
  emit(closedAt + 40, { type: 'job.dispatched', job: { ...job } });
  winner.busySlots += 1;
  util(closedAt + 50, winner);
  const tps = o.jobType === 'embed' ? winner.benchmark.embedTps : winner.benchmark.genTps;
  const dur = Math.round(jitter((o.units / tps) * 1000 + 120, 0.15));
  const doneAt = closedAt + 60 + dur;
  winner.busySlots -= 1;
  winner.jobsDone += 1;
  const cheatCaught = winner.cheat && o.jobType === 'embed';
  const sampled = o.sampled ?? (cheatCaught || rnd() < 0.2);
  const cosine = cheatCaught ? Number((rnd() * 0.06).toFixed(3)) : Number((0.996 + rnd() * 0.004).toFixed(4));
  emit(doneAt, { type: 'job.completed', job: { ...job, status: sampled ? 'verifying' : 'done', latencyMs: dur, verification: { sampled } } });
  util(doneAt + 10, winner);
  const payment: PaymentView = { id: `pay-${jobId}`, jobId, auctionId: id, rail: 'x402', currency, amount: String(amount), payer: BUYER_EVM, payee: winner.evmAddress, payeeName: winner.name, status: 'verified', createdAt: T0 + Math.round(doneAt + 20) };
  emit(doneAt + 20, { type: 'payment.verified', payment: { ...payment } });
  if (sampled) {
    if (cheatCaught) {
      winner.strikes += 1;
      emit(doneAt + 380, { type: 'verify.failed', jobId, providerId: winner.id, cosine, strikes: winner.strikes });
      emit(doneAt + 390, { type: 'provider.strike', providerId: winner.id, strikes: winner.strikes, jobId });
      emit(doneAt + 420, { type: 'payment.not_settled', payment: { ...payment, status: 'not_settled', reason: 'failed verification — provider unpaid', createdAt: T0 + Math.round(doneAt + 420) } });
      if (winner.strikes >= 2) {
        const del = xrplTx();
        winner.status = 'suspended';
        winner.credential = { ...(winner.credential ?? { type: '', status: '' }), deleteTx: del, status: 'revoked' };
        emit(doneAt + 2600, { type: 'credential.revoked', providerId: winner.id, providerName: winner.name, txHash: del, strikes: winner.strikes });
        emit(doneAt + 2650, { type: 'provider.suspended', providerId: winner.id, strikes: winner.strikes, deleteTx: del });
      }
      return { winner, clearing, done: doneAt + 2700 };
    }
    emit(doneAt + 380, { type: 'verify.passed', jobId, providerId: winner.id, cosine });
  }
  const settleAt = doneAt + (sampled ? 400 : 60) + 2200 + rnd() * 900;
  const tx = evmTx();
  const settled: PaymentView = { ...payment, status: 'settled', txHash: tx, explorerUrl: `https://sepolia.basescan.org/tx/${tx}`, createdAt: T0 + Math.round(settleAt) };
  settledPayments.push(settled);
  winner.earnings.ausd = addAtomic(winner.earnings.ausd, amount);
  stats.ausdSettled = addAtomic(stats.ausdSettled, amount);
  emit(settleAt, { type: 'payment.settled', payment: settled });
  return { winner, clearing, done: settleAt };
}

// ---------- 8 s – 30 s: indexer fills the market ----------
log(7000, 'indexer', 'thought', 'Indexing https://ollama.com/blog. 12 pages scraped via Context.dev, 188 chunks of ~800 chars.');
log(7400, 'indexer', 'action', 'market_snapshot(): 3 data centers verified, embed clearing at floor (10–18 µAUSD/text). Buying in batches of 64.');
let t = 8000;
for (let i = 0; i < 9; i++) {
  const r = runAuction(t, { jobType: 'embed', units: 64, persona: 'indexer', maxUnitPrice: 20, deadlineMs: 60_000 });
  if (r.winner && r.clearing !== undefined) {
    log(t + 300, 'indexer', 'action', `buy_embeddings(64 texts, max 20) → ${r.winner.name} at ${r.clearing} µAUSD/text (2nd price)`);
    log(r.done, 'indexer', 'spend', `paid ${(r.clearing * 64 / 1e6).toFixed(6)} AUSD to ${r.winner.name} over x402, settled on Base Sepolia`, { amount: String(r.clearing * 64), currency: 'AUSD' });
  }
  t += 2300 + rnd() * 500;
  if (i % 3 === 2) pushStats(t - 100);
}

// ---------- 30 s – 50 s: analyst enters, prices rise ----------
log(29_500, 'analyst', 'thought', 'Question: fastest open models on Apple Silicon right now. Searching with Context.dev, top 8 results.');
log(30_200, 'analyst', 'action', 'web_search("Apple Silicon local LLM inference benchmarks") → 8 results; scraping 6 pages to markdown.');
log(31_400, 'analyst', 'thought', 'Deadline is 3 s per job. Market is busy (indexer). I will pay up to 35 µAUSD/text.');
t = 31_000;
let outbid = false;
for (let i = 0; i < 8; i++) {
  const analyst = i % 2 === 0 || i >= 5;
  if (analyst) {
    const r = runAuction(t, { jobType: 'embed', units: 48, persona: 'analyst', maxUnitPrice: 35, deadlineMs: 3000 });
    if (r.winner && r.clearing !== undefined) {
      log(t + 300, 'analyst', 'action', `buy_embeddings(48 texts, max 35, deadline 3 s) → ${r.winner.name} at ${r.clearing} µAUSD/text`);
      log(r.done, 'analyst', 'spend', `paid ${(r.clearing * 48 / 1e6).toFixed(6)} AUSD to ${r.winner.name}, verified then settled`, { amount: String(r.clearing * 48), currency: 'AUSD' });
    }
  } else {
    const r = runAuction(t, { jobType: 'embed', units: 64, persona: 'indexer', maxUnitPrice: 18, deadlineMs: 60_000 });
    if (!r.winner && !outbid) {
      outbid = true;
      log(t + 400, 'indexer', 'thought', 'Outbid at 18 µAUSD/text. Prices are surging while the analyst is active. Waiting 20 s for cheaper supply.');
    } else if (r.winner && r.clearing !== undefined) {
      log(r.done, 'indexer', 'spend', `paid ${(r.clearing * 64 / 1e6).toFixed(6)} AUSD to ${r.winner.name}`, { amount: String(r.clearing * 64), currency: 'AUSD' });
    }
  }
  t += 2200 + rnd() * 400;
}
// a generate job for the analyst's draft
{
  const r = runAuction(t, { jobType: 'generate', units: 256, persona: 'analyst', maxUnitPrice: 40, deadlineMs: 12_000 });
  if (r.winner && r.clearing !== undefined) {
    log(t + 300, 'analyst', 'action', `buy_generation(256 tokens, x402) → ${r.winner.name} at ${r.clearing} µAUSD/token`);
    log(r.done, 'analyst', 'spend', `paid ${(r.clearing * 256 / 1e6).toFixed(6)} AUSD for a 256-token draft`, { amount: String(r.clearing * 256), currency: 'AUSD' });
  }
  t = r.done + 800;
}
pushStats(t);

// ---------- ~52 s: DC-SF-3 cheats, gets caught twice, revoked ----------
const sf = byId['dc-sf-3'];
sf.cheat = true;
util(t, sf);
log(t + 200, 'indexer', 'thought', 'A new ask appeared 40% under the floor. Suspicious, but the exchange verifies work before paying — taking it.');
for (let i = 0; i < 2; i++) {
  t += 600;
  const r = runAuction(t, { jobType: 'embed', units: 64, persona: 'indexer', maxUnitPrice: 20, deadlineMs: 60_000, sampled: true });
  if (r.winner && r.clearing !== undefined) {
    log(t + 300, 'indexer', 'action', `buy_embeddings(64 texts, max 20) → ${r.winner.name} at ${r.clearing} µAUSD/text`);
    log(r.done - 2000, 'indexer', 'error', `${r.winner.name} failed the spot check (random vectors). Not charged — resubmitting the batch.`);
  }
  t = r.done + 300;
}
pushStats(t);

// ---------- ~62 s: Oakland drains → supply drops, price spikes ----------
const oak = byId['dc-oakland-2'];
oak.draining = true;
util(t + 500, oak);
t += 1200;
for (let i = 0; i < 3; i++) {
  const r = runAuction(t, { jobType: 'embed', units: 64, persona: 'indexer', maxUnitPrice: 40, deadlineMs: 60_000 });
  if (i === 0) log(t + 400, 'indexer', 'thought', 'DC-Oakland-2 is draining (lid closed?). Only one data center left — raising my max to 40 so the batch still clears.');
  if (r.winner && r.clearing !== undefined) log(r.done, 'indexer', 'spend', `paid ${(r.clearing * 64 / 1e6).toFixed(6)} AUSD to ${r.winner.name} — supply is tight`, { amount: String(r.clearing * 64), currency: 'AUSD' });
  if (i === 0) {
    oak.online = false;
    oak.busySlots = 0;
    emit(t + 900, { type: 'provider.offline', providerId: oak.id });
  }
  t += 2400;
}
pushStats(t);

// ---------- ~72 s: analyst streams its answer over an XRPL payment channel ----------
const berk = byId['dc-berkeley-1'];
const streamId = 'st-001';
const dropsPerToken = 44;
const channelId = xrplTx();
log(t, 'analyst', 'thought', 'Ranked 188 chunks by cosine, kept the top 12. Streaming the cited answer over an XRPL payment channel so I pay per token and can stop early.');
emit(t + 200, { type: 'auction.opened', auction: { id: 'auc-stream-1', jobType: 'stream', model: 'llama3.2:3b', units: 300, currency: 'XRP', maxUnitPrice: '60', deadlineMs: 15_000, persona: 'analyst', agentId: 'agent-analyst', openedAt: T0 + Math.round(t + 200), status: 'open', bids: [] } });
const sBids: BidView[] = [
  { providerId: berk.id, providerName: berk.name, unitPrice: '44', etaMs: 310, valid: true, receivedAt: T0 + Math.round(t + 260) },
];
emit(t + 260, { type: 'auction.bid', auctionId: 'auc-stream-1', bid: sBids[0] });
emit(t + 470, { type: 'auction.cleared', auction: { id: 'auc-stream-1', jobType: 'stream', model: 'llama3.2:3b', units: 300, currency: 'XRP', maxUnitPrice: '60', deadlineMs: 15_000, persona: 'analyst', agentId: 'agent-analyst', openedAt: T0 + Math.round(t + 200), closedAt: T0 + Math.round(t + 470), status: 'cleared', winnerProviderId: berk.id, winnerName: berk.name, clearingUnitPrice: String(dropsPerToken), bids: sBids } });
stats.clearing.stream = String(dropsPerToken);
emit(t + 475, { type: 'price.tick', tick: { jobType: 'stream', currency: 'XRP', unitPrice: String(dropsPerToken), ts: T0 + Math.round(t + 475) } });
emit(t + 900, { type: 'paychan.opened', streamId, channelId, buyer: BUYER_XRPL, providerId: berk.id, dropsPerToken: String(dropsPerToken) });
log(t + 950, 'analyst', 'action', `stream → ${berk.name} at ${dropsPerToken} drops/token over channel ${channelId.slice(0, 8)}…; signing a claim every 16 tokens`);
berk.busySlots += 1;
util(t + 1000, berk);
const tokStart = t + 1200;
const perTok = 48;
const stopAt = 150;
for (let i = 0; i < stopAt; i++) {
  const tt = tokStart + i * perTok;
  if (i % 3 === 0) emit(tt, { type: 'stream.token', streamId, providerId: berk.id, index: i });
  if ((i + 1) % 16 === 0) {
    const tokens = i + 1;
    emit(tt + 10, { type: 'paychan.claim', streamId, providerId: berk.id, drops: String(tokens * dropsPerToken), tokens });
  }
}
const tEnd = tokStart + stopAt * perTok;
log(tEnd + 50, 'analyst', 'action', `stop(): answer complete at ${stopAt} tokens. Final claim covers exactly ${stopAt} × ${dropsPerToken} = ${stopAt * dropsPerToken} drops.`);
emit(tEnd + 60, { type: 'paychan.claim', streamId, providerId: berk.id, drops: String(stopAt * dropsPerToken), tokens: stopAt });
berk.busySlots -= 1;
util(tEnd + 100, berk);
const claimTx = xrplTx();
stats.dropsStreamed = addAtomic(stats.dropsStreamed, stopAt * dropsPerToken);
berk.earnings.drops = addAtomic(berk.earnings.drops, stopAt * dropsPerToken);
emit(tEnd + 2600, { type: 'paychan.claimed', streamId, providerId: berk.id, txHash: claimTx, drops: String(stopAt * dropsPerToken), tokens: stopAt });
log(tEnd + 2650, 'analyst', 'spend', `paid ${(stopAt * dropsPerToken / 1e6).toFixed(6)} XRP for ${stopAt} delivered tokens (PaymentChannelClaim)`, { amount: String(stopAt * dropsPerToken), currency: 'XRP' });
log(tEnd + 3000, 'analyst', 'result', 'On Apple Silicon the fastest small open models right now are Llama 3.2 3B and Qwen2.5 1.5B, both well above 40 tok/s on M3-class chips; Gemma 2 2B is close behind. Sources: ollama.com/blog, github.com/ggml-org/llama.cpp/discussions, apple.com/machine-learning.');
log(tEnd + 3200, 'analyst', 'result', 'Spend report: 11 jobs, 0.004 AUSD over x402, 0.0066 XRP streamed. Every payment settled only after verification.');
t = tEnd + 4000;
pushStats(t);

// ---------- tail: a couple more quiet auctions so the loop ends on motion ----------
for (let i = 0; i < 2; i++) {
  const r = runAuction(t, { jobType: 'embed', units: 64, persona: 'indexer', maxUnitPrice: 30, deadlineMs: 60_000 });
  if (r.winner && r.clearing !== undefined) log(r.done, 'indexer', 'spend', `paid ${(r.clearing * 64 / 1e6).toFixed(6)} AUSD to ${r.winner.name}`, { amount: String(r.clearing * 64), currency: 'AUSD' });
  t += 2600;
}
pushStats(t);

frames.sort((a, b) => a.ts - b.ts);
const out = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../public/replay/demo.jsonl');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
console.log(`wrote ${frames.length} frames spanning ${((frames.at(-1)!.ts - frames[0].ts) / 1000).toFixed(1)} s → ${path.relative(process.cwd(), out)}`);
