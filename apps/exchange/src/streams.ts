import type { WebSocket } from 'ws';
import { StreamClientMessage, xrplTx } from '@idle/shared';
import type { CreateStreamRequest, StreamQuote, StreamServerMessage, ProviderMessage } from '@idle/shared';
import type { Ctx } from './context';
import type { LiveProvider } from './providers';
import type { JobRow } from './db/repo';
import { jobView, paymentView } from './views';
import { newId, now } from './ids';

interface StreamQuoteState {
  quote: StreamQuote;
  jobId: string;
  providerId: string;
  reservationKey: string;
  prompt: string;
  model: string;
  maxTokens: number;
  expiresAt: number;
  consumed: boolean;
}

interface Session {
  streamId: string;
  jobId: string;
  providerId: string;
  ws: WebSocket;
  dropsPerToken: bigint;
  tokensDelivered: number;
  authorizedDrops: bigint;
  priorDrops: bigint;
  claimedDrops: bigint;
  channelId: string;
  buyerAddress: string;
  buyerPublicKey: string;
  startedAt: number;
  ended: boolean;
}

export type StreamQuoteOutcome =
  | { kind: 'quote'; quote: StreamQuote }
  | { kind: 'no_capacity'; retryAfterMs: number }
  | { kind: 'no_acceptable_bid'; auctionId: string; bestBid?: StreamQuote['bids'][number]; suggestedMaxUnitPrice?: bigint };

type StreamProviderMsg = Extract<ProviderMessage, { type: 'stream.token' | 'stream.paused' | 'stream.end' | 'stream.claimed' }>;

/** Rail B relay: agent ⇄ exchange ⇄ provider, with claims passed through and settlements recorded. */
export class StreamHub {
  private quotes = new Map<string, StreamQuoteState>();
  private sessions = new Map<string, Session>();

  constructor(private ctx: Ctx) {}

  async quote(req: CreateStreamRequest): Promise<StreamQuoteOutcome> {
    const { config, repo, auctions, registry } = this.ctx;
    const model = req.model ?? config.genModel;
    const jobId = newId('j');
    const createdAt = now();
    const row: JobRow = {
      id: jobId,
      auction_id: null,
      buyer_id: req.agentId ?? null,
      persona: req.persona ?? null,
      job_type: 'stream',
      model,
      units: req.maxTokens,
      rail: 'xrpl',
      status: 'quoted',
      provider_id: null,
      unit_price: '0',
      amount: '0',
      currency: 'XRP',
      result_ref: null,
      latency_ms: null,
      verify_json: null,
      error: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    repo.insertJob(row);
    const quoteId = newId('q');
    const outcome = await auctions.run(
      { jobType: 'stream', model, units: req.maxTokens, currency: 'XRP', maxUnitPrice: BigInt(req.maxDropsPerToken), deadlineMs: req.deadlineMs, persona: req.persona, agentId: req.agentId, jobId },
      () => this.expire(quoteId),
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
    const expiresAt = now() + config.quoteTtlMs;
    const streamId = newId('s');
    const quote: StreamQuote = {
      quoteId,
      streamId,
      auctionId: auction.id,
      providerId: winner.id,
      providerName: winner.name,
      providerXrplAddress: winner.xrplAddress,
      dropsPerToken: clearingUnitPrice.toString(),
      maxTokens: req.maxTokens,
      expiresAt,
      bids: auction.bids,
    };
    repo.updateJob(jobId, { auction_id: auction.id, provider_id: winner.id, unit_price: quote.dropsPerToken, amount: (clearingUnitPrice * BigInt(req.maxTokens)).toString() });
    this.quotes.set(quoteId, { quote, jobId, providerId: winner.id, reservationKey, prompt: req.prompt, model, maxTokens: req.maxTokens, expiresAt, consumed: false });
    registry.emitUtil(winner);
    return { kind: 'quote', quote };
  }

  private expire(quoteId: string): void {
    const s = this.quotes.get(quoteId);
    if (!s || s.consumed) return;
    this.quotes.delete(quoteId);
    this.ctx.repo.deleteJob(s.jobId);
    this.ctx.registry.send(s.providerId, { type: 'release', auctionId: s.quote.auctionId });
  }

  private sendAgent(ws: WebSocket, msg: StreamServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  handleSocket(ws: WebSocket, quoteId: string): void {
    const state = this.quotes.get(quoteId);
    if (!state || state.consumed || state.expiresAt <= now()) {
      this.sendAgent(ws, { type: 'error', code: 'QUOTE_NOT_FOUND', message: 'unknown or expired stream quote' });
      ws.close(4004, 'quote not found');
      return;
    }
    let session: Session | undefined;
    ws.on('message', (data) => {
      let parsed;
      try {
        parsed = StreamClientMessage.safeParse(JSON.parse(data.toString()));
      } catch {
        return this.sendAgent(ws, { type: 'error', code: 'BAD_JSON', message: 'invalid json' });
      }
      if (!parsed.success) return this.sendAgent(ws, { type: 'error', code: 'BAD_MESSAGE', message: parsed.error.message });
      const msg = parsed.data;
      if (msg.type === 'open') {
        if (session) return;
        session = this.open(ws, state, msg);
        return;
      }
      if (!session) return;
      // After `end`, the buyer's final claim (covering the last < 16 tokens) must still reach the provider.
      if (session.ended && msg.type !== 'claim') return;
      if (msg.type === 'claim') {
        const drops = BigInt(msg.amountDrops);
        if (drops > session.authorizedDrops) session.authorizedDrops = drops;
        this.ctx.repo.updateStream(session.streamId, { authorized_drops: session.authorizedDrops.toString(), tokens_delivered: session.tokensDelivered });
        this.ctx.registry.send(session.providerId, { type: 'stream.claim', streamId: session.streamId, amountDrops: msg.amountDrops, signature: msg.signature });
        this.ctx.events.emit({ type: 'paychan.claim', streamId: session.streamId, providerId: session.providerId, drops: msg.amountDrops, tokens: session.tokensDelivered });
      } else if (msg.type === 'stop') {
        this.ctx.registry.send(session.providerId, { type: 'stream.stop', streamId: session.streamId });
      }
    });
    ws.on('close', () => {
      if (!session) {
        if (!state.consumed) {
          state.consumed = true;
          this.quotes.delete(quoteId);
          this.ctx.registry.release(state.reservationKey);
          this.ctx.repo.deleteJob(state.jobId);
          this.ctx.registry.send(state.providerId, { type: 'release', auctionId: state.quote.auctionId });
        }
        return;
      }
      if (!session.ended) this.ctx.registry.send(session.providerId, { type: 'stream.stop', streamId: session.streamId });
    });
  }

  private open(ws: WebSocket, state: StreamQuoteState, msg: Extract<StreamClientMessage, { type: 'open' }>): Session | undefined {
    const { registry, repo, events } = this.ctx;
    if (state.consumed) {
      this.sendAgent(ws, { type: 'error', code: 'QUOTE_CONSUMED', message: 'this stream quote was already opened' });
      ws.close(4006, 'quote consumed');
      return undefined;
    }
    const p = registry.get(state.providerId);
    if (!p || !p.online || p.status !== 'verified') {
      this.sendAgent(ws, { type: 'error', code: 'PROVIDER_OFFLINE', message: 'winning provider is no longer available' });
      state.consumed = true;
      this.quotes.delete(state.quote.quoteId);
      registry.release(state.reservationKey);
      repo.deleteJob(state.jobId);
      ws.close(4005, 'provider offline');
      return undefined;
    }
    state.consumed = true;
    this.quotes.delete(state.quote.quoteId);
    registry.consume(state.reservationKey);
    const streamId = state.quote.streamId;
    const session: Session = {
      streamId,
      jobId: state.jobId,
      providerId: p.id,
      ws,
      dropsPerToken: BigInt(state.quote.dropsPerToken),
      tokensDelivered: 0,
      authorizedDrops: BigInt(msg.priorClaimedDrops),
      priorDrops: BigInt(msg.priorClaimedDrops),
      claimedDrops: 0n,
      channelId: msg.channelId,
      buyerAddress: msg.buyerAddress,
      buyerPublicKey: msg.publicKey,
      startedAt: now(),
      ended: false,
    };
    this.sessions.set(streamId, session);
    repo.insertStream({
      id: streamId,
      job_id: state.jobId,
      provider_id: p.id,
      channel_id: msg.channelId,
      buyer_address: msg.buyerAddress,
      buyer_pubkey: msg.publicKey,
      drops_per_token: state.quote.dropsPerToken,
      tokens_delivered: 0,
      authorized_drops: msg.priorClaimedDrops,
      claimed_drops: '0',
      claim_tx: null,
      status: 'running',
      created_at: now(),
      updated_at: now(),
    });
    repo.updateJob(state.jobId, { status: 'running' });
    const row = repo.getJob(state.jobId);
    if (row) events.emit({ type: 'job.dispatched', job: jobView(row, registry.nameOf) });
    events.emit({ type: 'paychan.opened', streamId, channelId: msg.channelId, buyer: msg.buyerAddress, providerId: p.id, dropsPerToken: state.quote.dropsPerToken });
    registry.send(p.id, {
      type: 'stream.start',
      streamId,
      jobId: state.jobId,
      model: state.model,
      prompt: state.prompt,
      maxTokens: state.maxTokens,
      channelId: msg.channelId,
      buyerAddress: msg.buyerAddress,
      buyerPublicKey: msg.publicKey,
      dropsPerToken: state.quote.dropsPerToken,
      priorClaimedDrops: msg.priorClaimedDrops,
    });
    this.sendAgent(ws, { type: 'started', streamId, dropsPerToken: state.quote.dropsPerToken });
    return session;
  }

  onProviderMessage(p: LiveProvider, msg: StreamProviderMsg): void {
    const s = this.sessions.get(msg.streamId);
    if (!s || s.providerId !== p.id) return;
    const { repo, events, registry } = this.ctx;
    switch (msg.type) {
      case 'stream.token':
        s.tokensDelivered = Math.max(s.tokensDelivered, msg.index + 1);
        this.sendAgent(s.ws, { type: 'token', token: msg.token, index: msg.index });
        if (msg.index % 4 === 0) events.emit({ type: 'stream.token', streamId: s.streamId, providerId: p.id, index: msg.index });
        return;
      case 'stream.paused':
        this.sendAgent(s.ws, { type: 'paused', unpaidTokens: msg.unpaidTokens });
        return;
      case 'stream.end': {
        s.ended = true;
        s.tokensDelivered = msg.tokensDelivered;
        registry.finishRunning(p);
        repo.updateStream(s.streamId, { tokens_delivered: msg.tokensDelivered, status: 'ended' });
        const failed = msg.reason === 'error';
        repo.updateJob(s.jobId, { status: failed ? 'failed' : 'done', latency_ms: now() - s.startedAt, error: msg.error ?? null, units: msg.tokensDelivered, amount: (BigInt(msg.tokensDelivered) * s.dropsPerToken).toString() });
        const row = repo.getJob(s.jobId);
        if (row) events.emit(failed ? { type: 'job.failed', job: jobView(row, registry.nameOf), error: msg.error ?? 'stream error' } : { type: 'job.completed', job: jobView(row, registry.nameOf) });
        if (!failed) {
          p.jobsDone++;
          repo.updateProvider(p.id, { jobs_done: p.jobsDone });
        }
        this.sendAgent(s.ws, { type: 'end', tokensDelivered: msg.tokensDelivered, reason: msg.reason, error: msg.error });
        return;
      }
      case 'stream.claimed': {
        const drops = BigInt(msg.drops);
        s.claimedDrops = drops;
        repo.updateStream(s.streamId, { claimed_drops: msg.drops, claim_tx: msg.txHash, status: 'claimed' });
        const payment = {
          id: newId('pay'),
          job_id: s.jobId,
          auction_id: repo.getJob(s.jobId)?.auction_id ?? null,
          rail: 'xrpl',
          currency: 'XRP',
          amount_atomic: (drops > s.priorDrops ? drops - s.priorDrops : 0n).toString(),
          payer: s.buyerAddress,
          payee: p.xrplAddress,
          payee_provider_id: p.id,
          tx_hash: msg.txHash,
          status: 'settled',
          reason: `${msg.tokens} tokens over channel ${s.channelId.slice(0, 8)}…`,
          created_at: now(),
        };
        repo.insertPayment(payment);
        p.earningsDrops += drops > s.priorDrops ? drops - s.priorDrops : 0n;
        repo.updateProvider(p.id, { earnings_drops: p.earningsDrops.toString() });
        events.emit({ type: 'paychan.claimed', streamId: s.streamId, providerId: p.id, txHash: msg.txHash, drops: msg.drops, tokens: msg.tokens });
        events.emit({ type: 'payment.settled', payment: paymentView(payment, registry.nameOf) });
        this.sendAgent(s.ws, { type: 'claimed', txHash: msg.txHash, drops: msg.drops, tokens: msg.tokens, explorerUrl: xrplTx(msg.txHash) });
        this.sessions.delete(s.streamId);
        return;
      }
    }
  }
}
