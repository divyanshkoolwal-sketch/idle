import type { CreateJobRequest, Quote, JobResult, ExchangeMessage, ProviderMessage, JobType } from '@idle/shared';
import type { Ctx } from './context';
import type { LiveProvider } from './providers';
import type { JobRow } from './db/repo';
import { jobView } from './views';
import { newId, now } from './ids';

type JobInput = CreateJobRequest['input'];
type ResultMsg = Extract<ProviderMessage, { type: 'result' }>;

export interface QuoteState {
  quote: Quote;
  idemKey?: string;
  reservationKey: string;
  jobType: 'embed' | 'generate';
  model: string;
  input: JobInput;
  deadlineMs: number;
  persona?: string;
  agentId?: string;
  expiresAt: number;
  consumed: boolean;
}

export type QuoteOutcome =
  | { kind: 'quote'; quote: Quote; state: QuoteState }
  | { kind: 'no_capacity'; retryAfterMs: number }
  | { kind: 'no_acceptable_bid'; auctionId: string; bestBid?: Quote['bids'][number]; suggestedMaxUnitPrice?: bigint }
  | { kind: 'bad_request'; message: string };

export type RunOutcome =
  | { ok: true; result: JobResult }
  | {
      ok: false;
      code: 'PROVIDER_FAILED_VERIFICATION' | 'PROVIDER_ERROR' | 'PROVIDER_OFFLINE' | 'TIMEOUT';
      jobId: string;
      providerId: string;
      providerName: string;
      cosine?: number;
      error?: string;
      latencyMs?: number;
    };

const MAX_TEXTS = 64;
const MAX_TOKENS = 256;

/** Quote → (pay) → run. Transport-agnostic so the x402 gate can sit between quote and run. */
export class Market {
  private quotes = new Map<string, QuoteState>();
  private byIdem = new Map<string, string>();
  private pending = new Map<string, { providerId: string; resolve: (m: ResultMsg | undefined) => void; timer: NodeJS.Timeout }>();

  constructor(private ctx: Ctx) {}

  quoteByIdem(key: string): QuoteState | undefined {
    const id = this.byIdem.get(key);
    const s = id ? this.quotes.get(id) : undefined;
    if (s && !s.consumed && s.expiresAt > now()) return s;
    return undefined;
  }
  getQuote(quoteId: string): QuoteState | undefined {
    const s = this.quotes.get(quoteId);
    return s && !s.consumed && s.expiresAt > now() ? s : undefined;
  }

  async quoteJob(req: CreateJobRequest, opts: { idemKey?: string } = {}): Promise<QuoteOutcome> {
    const { config, repo, auctions, registry } = this.ctx;
    const jobType = req.jobType;
    let units: number;
    let input: JobInput = req.input;
    if (jobType === 'embed') {
      const texts = req.input.texts ?? [];
      if (!texts.length) return { kind: 'bad_request', message: 'input.texts required for embed' };
      if (texts.length > MAX_TEXTS) return { kind: 'bad_request', message: `at most ${MAX_TEXTS} texts per job` };
      units = texts.length;
    } else {
      if (!req.input.prompt) return { kind: 'bad_request', message: 'input.prompt required for generate' };
      const maxTokens = Math.min(req.input.maxTokens ?? 128, MAX_TOKENS);
      input = { ...req.input, maxTokens };
      units = maxTokens; // charged on maxTokens
    }
    const model = req.model ?? (jobType === 'embed' ? config.embedModel : config.genModel);
    const jobId = newId('j');
    const quoteId = newId('q');
    const createdAt = now();
    const row: JobRow = {
      id: jobId,
      auction_id: null,
      buyer_id: req.agentId ?? null,
      persona: req.persona ?? null,
      job_type: jobType,
      model,
      units,
      rail: 'x402',
      status: 'quoted',
      provider_id: null,
      unit_price: '0',
      amount: '0',
      currency: 'AUSD',
      result_ref: null,
      latency_ms: null,
      verify_json: null,
      error: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    repo.insertJob(row);

    const outcome = await auctions.run(
      { jobType, model, units, currency: 'AUSD', maxUnitPrice: BigInt(req.maxUnitPrice), deadlineMs: req.deadlineMs, minTier: req.minTier, persona: req.persona, agentId: req.agentId, jobId },
      () => this.expireQuote(quoteId),
    );
    if (outcome.kind === 'no_capacity') {
      repo.deleteJob(jobId);
      return outcome;
    }
    if (outcome.kind === 'no_acceptable_bid') {
      repo.deleteJob(jobId);
      return { kind: 'no_acceptable_bid', auctionId: outcome.auction.id, bestBid: outcome.bestBid, suggestedMaxUnitPrice: outcome.suggestedMaxUnitPrice };
    }
    const { winner, clearingUnitPrice, auction, reservationKey } = outcome;
    const amount = clearingUnitPrice * BigInt(units);
    const expiresAt = now() + config.quoteTtlMs;
    const quote: Quote = {
      quoteId,
      auctionId: auction.id,
      jobId,
      providerId: winner.id,
      providerName: winner.name,
      providerXrplAddress: winner.xrplAddress,
      payTo: winner.evmAddress,
      unitPrice: clearingUnitPrice.toString(),
      units,
      amount: amount.toString(),
      currency: 'AUSD',
      expiresAt,
      bids: auction.bids,
    };
    repo.updateJob(jobId, { auction_id: auction.id, provider_id: winner.id, unit_price: quote.unitPrice, amount: quote.amount });
    const state: QuoteState = { quote, idemKey: opts.idemKey, reservationKey, jobType, model, input, deadlineMs: req.deadlineMs, persona: req.persona, agentId: req.agentId, expiresAt, consumed: false };
    this.quotes.set(quoteId, state);
    if (opts.idemKey) this.byIdem.set(opts.idemKey, quoteId);
    registry.emitUtil(winner);
    return { kind: 'quote', quote, state };
  }

  private expireQuote(quoteId: string): void {
    const s = this.quotes.get(quoteId);
    if (!s || s.consumed) return;
    this.forget(s);
    this.ctx.repo.deleteJob(s.quote.jobId);
    this.ctx.registry.send(s.quote.providerId, { type: 'release', auctionId: s.quote.auctionId });
  }

  /** Payment failed / client went away: free the slot. */
  releaseQuote(quoteId: string, reason: string): void {
    const s = this.quotes.get(quoteId);
    if (!s || s.consumed) return;
    this.ctx.registry.release(s.reservationKey);
    this.forget(s);
    this.ctx.repo.deleteJob(s.quote.jobId);
    this.ctx.registry.send(s.quote.providerId, { type: 'release', auctionId: s.quote.auctionId });
    console.log(`[market] released quote ${quoteId}: ${reason}`);
  }

  private forget(s: QuoteState): void {
    this.quotes.delete(s.quote.quoteId);
    if (s.idemKey && this.byIdem.get(s.idemKey) === s.quote.quoteId) this.byIdem.delete(s.idemKey);
  }

  async runJob(state: QuoteState): Promise<RunOutcome> {
    const { registry, repo, events, verifier, config } = this.ctx;
    if (state.consumed) throw new Error('quote already consumed');
    state.consumed = true;
    this.forget(state);
    const q = state.quote;
    const p = registry.get(q.providerId);
    const providerName = p?.name ?? q.providerName;
    const fail = (code: Exclude<RunOutcome, { ok: true }>['code'], error: string, extra: { cosine?: number; latencyMs?: number } = {}): RunOutcome => {
      repo.updateJob(q.jobId, { status: 'failed', error, latency_ms: extra.latencyMs ?? null, verify_json: extra.cosine !== undefined ? JSON.stringify({ sampled: true, passed: false, cosine: extra.cosine }) : null });
      const row = repo.getJob(q.jobId);
      if (row) events.emit({ type: 'job.failed', job: jobView(row, registry.nameOf), error });
      return { ok: false, code, jobId: q.jobId, providerId: q.providerId, providerName, error, ...extra };
    };
    if (!p || !p.online || p.status !== 'verified') {
      registry.release(state.reservationKey);
      return fail('PROVIDER_OFFLINE', !p || !p.online ? 'winning provider went offline before dispatch' : `provider is ${p.status}`);
    }
    registry.consume(state.reservationKey);
    repo.updateJob(q.jobId, { status: 'running' });
    const dispatched = repo.getJob(q.jobId);
    if (dispatched) events.emit({ type: 'job.dispatched', job: jobView(dispatched, registry.nameOf) });

    const msg: ExchangeMessage = { type: 'job', jobId: q.jobId, auctionId: q.auctionId, jobType: state.jobType, model: state.model, input: state.input, unitPrice: q.unitPrice, currency: 'AUSD' };
    const t0 = now();
    const res = await this.awaitResult(q.jobId, p.id, state.deadlineMs + config.resultGraceMs, () => registry.send(p.id, msg));
    registry.finishRunning(p);
    const latencyMs = now() - t0;
    if (!res) return fail('TIMEOUT', `no result within ${state.deadlineMs + config.resultGraceMs} ms`, { latencyMs });
    if (!res.ok) return fail('PROVIDER_ERROR', res.error ?? 'provider reported an error', { latencyMs });
    const output = res.output ?? {};
    const texts = state.input.texts ?? [];
    if (state.jobType === 'embed' && (!output.embeddings || output.embeddings.length !== texts.length)) {
      return fail('PROVIDER_ERROR', `expected ${texts.length} embeddings, got ${output.embeddings?.length ?? 0}`, { latencyMs });
    }
    if (state.jobType === 'generate' && typeof output.text !== 'string') return fail('PROVIDER_ERROR', 'no text in generate result', { latencyMs });

    let verification: JobResult['verification'] = { sampled: false };
    if (state.jobType === 'embed' && output.embeddings) {
      // Suspiciously cheap work is always checked: a bid below the provider's own declared floor, or any prior strike.
      const winnerBid = q.bids.find((b) => b.providerId === p.id)?.unitPrice;
      const suspicious = (winnerBid !== undefined && BigInt(winnerBid) < BigInt(p.floors.embed)) || p.strikes > 0;
      verification = await verifier.spotCheck(p, q.jobId, texts, output.embeddings, suspicious);
      if (verification.sampled && verification.passed === false) {
        return fail('PROVIDER_FAILED_VERIFICATION', `spot check failed (cosine ${verification.cosine?.toFixed(4)})`, { cosine: verification.cosine, latencyMs });
      }
    }
    p.jobsDone++;
    repo.updateProvider(p.id, { jobs_done: p.jobsDone });
    repo.updateJob(q.jobId, { status: 'done', latency_ms: latencyMs, verify_json: JSON.stringify(verification) });
    const doneRow = repo.getJob(q.jobId);
    if (doneRow) events.emit({ type: 'job.completed', job: jobView(doneRow, registry.nameOf) });
    return { ok: true, result: { jobId: q.jobId, auctionId: q.auctionId, providerId: p.id, providerName: p.name, output, latencyMs, verification } };
  }

  onResult(providerId: string, msg: ResultMsg): void {
    const pend = this.pending.get(msg.jobId);
    if (!pend || pend.providerId !== providerId) return;
    clearTimeout(pend.timer);
    this.pending.delete(msg.jobId);
    pend.resolve(msg);
  }

  private awaitResult(jobId: string, providerId: string, timeoutMs: number, send: () => boolean): Promise<ResultMsg | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(jobId);
        resolve(undefined);
      }, timeoutMs);
      this.pending.set(jobId, { providerId, resolve, timer });
      if (!send()) {
        clearTimeout(timer);
        this.pending.delete(jobId);
        resolve(undefined);
      }
    });
  }

  /** Unpaid internal job (spot checks). Returns the output or undefined on timeout/error. */
  async dispatchInternal(p: LiveProvider, jobType: JobType, input: JobInput, model: string, timeoutMs: number): Promise<ResultMsg['output'] | undefined> {
    const jobId = newId('v');
    const msg: ExchangeMessage = { type: 'job', jobId, auctionId: 'internal', jobType, model, input, unitPrice: '0', currency: 'AUSD' };
    this.ctx.registry.startRunning(p);
    try {
      const res = await this.awaitResult(jobId, p.id, timeoutMs, () => this.ctx.registry.send(p.id, msg));
      return res?.ok ? res.output : undefined;
    } finally {
      this.ctx.registry.finishRunning(p);
    }
  }
}
