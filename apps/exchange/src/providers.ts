import { verifyHelloProof } from '@idle/pay-xrpl';
import type { WebSocket } from 'ws';
import { ProviderMessage, cosine, GOLDEN_TEXTS } from '@idle/shared';
import type { ExchangeMessage, ProviderView, ProviderStatus, Tier, JobType } from '@idle/shared';
import type { Ctx } from './context';
import type { ProviderRow } from './db/repo';
import { newId, now } from './ids';

type Hello = Extract<ProviderMessage, { type: 'hello' }>;

export interface LiveProvider {
  id: string;
  name: string;
  region: string;
  hardware: Hello['hardware'];
  evmAddress: string;
  xrplAddress: string;
  xrplPublicKey: string;
  models: string[];
  slots: number;
  benchmark: Hello['benchmark'];
  floors: Hello['floors'];
  status: ProviderStatus;
  tier?: Tier;
  strikes: number;
  earningsAusd: bigint;
  earningsDrops: bigint;
  jobsDone: number;
  wins: number;
  cheat: boolean;
  draining: boolean;
  online: boolean;
  lastSeen: number;
  busySlots: number;
  queueDepth: number;
  shade: number;
  surge: number;
  asks: { embed: string; generate: string; stream: string };
  /** jobs dispatched by this exchange and not yet finished */
  running: number;
  /** quote reservations (key → expiry timer) */
  reservations: Map<string, NodeJS.Timeout>;
  credential?: { type: string; issueTx?: string; acceptTx?: string; deleteTx?: string; status: string };
  challenge?: { id: string; order: number[]; sentAt: number; timer: NodeJS.Timeout; attempt: number };
  socket?: WebSocket;
  createdAt: number;
}

const TIER_RANK: Record<Tier, number> = { A: 2, B: 1 };

export class ProviderRegistry {
  readonly providers = new Map<string, LiveProvider>();
  private reservationOwner = new Map<string, string>();
  private sweeper: NodeJS.Timeout;

  constructor(private ctx: Ctx) {
    for (const row of ctx.repo.listProviders()) this.providers.set(row.id, this.fromRow(row));
    this.sweeper = setInterval(() => this.sweep(), 1000);
  }

  close(): void {
    clearInterval(this.sweeper);
  }

  get(id: string): LiveProvider | undefined {
    return this.providers.get(id);
  }
  nameOf = (id: string | null | undefined): string | undefined => (id ? this.providers.get(id)?.name : undefined);

  // ---------------------------------------------------------------- views
  freeSlots(p: LiveProvider): number {
    return Math.max(0, p.slots - Math.max(p.busySlots, p.running) - p.reservations.size);
  }
  reputation(p: LiveProvider): number {
    return p.jobsDone - 10 * p.strikes;
  }
  view(p: LiveProvider): ProviderView {
    return {
      id: p.id,
      name: p.name,
      region: p.region,
      hardware: p.hardware,
      evmAddress: p.evmAddress,
      xrplAddress: p.xrplAddress,
      models: p.models,
      slots: p.slots,
      busySlots: Math.max(p.busySlots, p.running) + p.reservations.size,
      queueDepth: p.queueDepth,
      benchmark: p.benchmark,
      tier: p.tier,
      status: p.status,
      strikes: p.strikes,
      shade: p.shade,
      surge: p.surge,
      asks: p.asks,
      floors: p.floors,
      credential: p.credential,
      earnings: { ausd: p.earningsAusd.toString(), drops: p.earningsDrops.toString() },
      jobsDone: p.jobsDone,
      cheat: p.cheat,
      draining: p.draining,
      online: p.online,
      lastSeen: p.lastSeen,
    };
  }
  views(): ProviderView[] {
    return [...this.providers.values()].map((p) => this.view(p));
  }

  eligible(opts: { model: string; minTier?: Tier; jobType: JobType }): LiveProvider[] {
    return [...this.providers.values()].filter(
      (p) =>
        p.online &&
        p.status === 'verified' &&
        !p.draining &&
        p.models.includes(opts.model) &&
        this.freeSlots(p) > 0 &&
        (!opts.minTier || (p.tier && TIER_RANK[p.tier] >= TIER_RANK[opts.minTier])),
    );
  }

  // ---------------------------------------------------------------- slots
  reserve(p: LiveProvider, key: string, ttlMs: number, onExpire?: () => void): void {
    const timer = setTimeout(() => {
      if (p.reservations.delete(key)) {
        this.reservationOwner.delete(key);
        this.emitUtil(p);
        onExpire?.();
      }
    }, ttlMs);
    p.reservations.set(key, timer);
    this.reservationOwner.set(key, p.id);
    this.emitUtil(p);
  }
  release(key: string): void {
    const pid = this.reservationOwner.get(key);
    if (!pid) return;
    const p = this.providers.get(pid);
    const t = p?.reservations.get(key);
    if (t) clearTimeout(t);
    p?.reservations.delete(key);
    this.reservationOwner.delete(key);
    if (p) this.emitUtil(p);
  }
  /** Converts a reservation into a running job. */
  consume(key: string): void {
    const pid = this.reservationOwner.get(key);
    if (!pid) return;
    const p = this.providers.get(pid);
    if (!p) return;
    const t = p.reservations.get(key);
    if (t) clearTimeout(t);
    p.reservations.delete(key);
    this.reservationOwner.delete(key);
    p.running++;
    this.emitUtil(p);
  }
  startRunning(p: LiveProvider): void {
    p.running++;
    this.emitUtil(p);
  }
  finishRunning(p: LiveProvider): void {
    p.running = Math.max(0, p.running - 1);
    this.emitUtil(p);
  }

  // ---------------------------------------------------------------- status
  setStatus(p: LiveProvider, status: ProviderStatus): void {
    p.status = status;
    this.ctx.repo.updateProvider(p.id, { status, tier: p.tier ?? null, strikes: p.strikes });
  }
  persist(p: LiveProvider): void {
    this.ctx.repo.upsertProvider(this.toRow(p));
  }

  send(providerId: string, msg: ExchangeMessage): boolean {
    const p = this.providers.get(providerId);
    const s = p?.socket;
    if (!s || s.readyState !== s.OPEN) return false;
    s.send(JSON.stringify(msg));
    return true;
  }

  forwardAdmin(providerId: string, kind: 'drain' | 'cheat', on: boolean): boolean {
    const p = this.providers.get(providerId);
    if (!p) return false;
    if (kind === 'drain') p.draining = on;
    else p.cheat = on;
    this.emitUtil(p);
    return this.send(providerId, { type: kind, on });
  }

  // ---------------------------------------------------------------- socket
  handleSocket(ws: WebSocket): void {
    let providerId: string | undefined;
    ws.on('message', (data) => {
      let parsed;
      try {
        parsed = ProviderMessage.safeParse(JSON.parse(data.toString()));
      } catch {
        ws.send(JSON.stringify({ type: 'error', code: 'BAD_JSON', message: 'invalid json' } satisfies ExchangeMessage));
        return;
      }
      if (!parsed.success) {
        ws.send(JSON.stringify({ type: 'error', code: 'BAD_MESSAGE', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } satisfies ExchangeMessage));
        return;
      }
      const msg = parsed.data;
      if (msg.type === 'hello') {
        providerId = this.onHello(ws, msg);
        return;
      }
      if (!providerId) {
        ws.send(JSON.stringify({ type: 'error', code: 'NOT_REGISTERED', message: 'send hello first' } satisfies ExchangeMessage));
        return;
      }
      const p = this.providers.get(providerId);
      if (!p) return;
      try {
        this.dispatch(p, msg);
      } catch (err) {
        console.error(`[providers] ${p.name} message ${msg.type} failed:`, err);
      }
    });
    ws.on('close', () => {
      if (!providerId) return;
      const p = this.providers.get(providerId);
      if (p && p.socket === ws) this.markOffline(p, 'socket closed');
    });
    ws.on('error', () => {
      /* close follows */
    });
  }

  private dispatch(p: LiveProvider, msg: ProviderMessage): void {
    p.lastSeen = now();
    switch (msg.type) {
      case 'challenge.result':
        this.onChallengeResult(p, msg);
        return;
      case 'credential.accepted':
        void this.ctx.credentials.onAccepted(p, msg.txHash);
        return;
      case 'bid':
      case 'pass':
        this.ctx.auctions.onBid(p.id, msg);
        return;
      case 'result':
        this.ctx.market.onResult(p.id, msg);
        return;
      case 'stream.token':
      case 'stream.paused':
      case 'stream.end':
      case 'stream.claimed':
        this.ctx.streams.onProviderMessage(p, msg);
        return;
      case 'heartbeat':
        this.onHeartbeat(p, msg);
        return;
      case 'hello':
        return;
    }
  }

  private seenNonces = new Map<string, number>();

  private onHello(ws: WebSocket, msg: Hello): string {
    // Identity: the hello must be signed by the XRPL key that owns xrplAddress (prevents payout redirection).
    const bad = verifyHelloProof(msg);
    for (const [n, t] of this.seenNonces) if (Date.now() - t > 10 * 60_000) this.seenNonces.delete(n);
    const reason = bad ?? (this.seenNonces.has(msg.proof.nonce) ? 'proof nonce reused' : null);
    if (reason) {
      console.warn(`[providers] rejected hello from ${msg.name} (${msg.xrplAddress}): ${reason}`);
      try {
        ws.send(JSON.stringify({ type: 'error', code: 'BAD_PROOF', message: reason }));
      } catch {
        /* ignore */
      }
      ws.close(4001, 'bad proof');
      return '';
    }
    this.seenNonces.set(msg.proof.nonce, Date.now());
    let p: LiveProvider | undefined;
    if (msg.providerId) {
      const cand = this.providers.get(msg.providerId);
      if (cand && cand.xrplAddress === msg.xrplAddress) p = cand;
    }
    if (!p) p = [...this.providers.values()].find((x) => x.xrplAddress === msg.xrplAddress);
    const fresh = !p;
    if (!p) {
      p = {
        id: newId('p'),
        name: msg.name,
        region: msg.region,
        hardware: msg.hardware,
        evmAddress: msg.evmAddress,
        xrplAddress: msg.xrplAddress,
        xrplPublicKey: msg.xrplPublicKey,
        models: msg.models,
        slots: msg.slots,
        benchmark: msg.benchmark,
        floors: msg.floors,
        status: 'pending',
        strikes: 0,
        earningsAusd: 0n,
        earningsDrops: 0n,
        jobsDone: 0,
        wins: 0,
        cheat: msg.cheat,
        draining: false,
        online: false,
        lastSeen: now(),
        busySlots: 0,
        queueDepth: 0,
        shade: 1,
        surge: 1,
        asks: { embed: msg.floors.embed, generate: msg.floors.generate, stream: msg.floors.streamDrops },
        running: 0,
        reservations: new Map(),
        createdAt: now(),
      };
      this.providers.set(p.id, p);
    } else {
      if (p.socket && p.socket !== ws && p.socket.readyState === p.socket.OPEN) p.socket.close(4000, 'replaced by new connection');
      Object.assign(p, {
        name: msg.name,
        region: msg.region,
        hardware: msg.hardware,
        evmAddress: msg.evmAddress,
        xrplPublicKey: msg.xrplPublicKey,
        models: msg.models,
        slots: msg.slots,
        benchmark: msg.benchmark,
        floors: msg.floors,
        cheat: msg.cheat,
      });
      p.asks = { embed: msg.floors.embed, generate: msg.floors.generate, stream: msg.floors.streamDrops };
      p.running = 0;
      p.busySlots = 0;
      p.draining = false;
    }
    p.socket = ws;
    p.online = true;
    p.lastSeen = now();
    this.persist(p);
    this.send(p.id, { type: 'welcome', providerId: p.id, issuerAddress: this.ctx.credentials.issuerAddress, status: p.status, tier: p.tier });
    this.ctx.events.emit({ type: 'provider.online', provider: this.view(p) });
    console.log(`[providers] ${fresh ? 'new' : 'back'}: ${p.name} (${p.id}) ${p.hardware.label} slots=${p.slots} status=${p.status}`);
    if (p.status === 'suspended') {
      this.send(p.id, { type: 'error', code: 'SUSPENDED', message: 'credential revoked after failed verification; not eligible to bid' });
      return p.id;
    }
    // Always re-run the onboarding challenge on (re)connect; it is cheap and proves the model tag.
    if (p.status === 'verified') this.setStatus(p, 'pending');
    this.startChallenge(p, 1);
    return p.id;
  }

  private startChallenge(p: LiveProvider, attempt: number): void {
    if (p.challenge) clearTimeout(p.challenge.timer);
    const idx = [...GOLDEN_TEXTS.keys()];
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const nonceText = `Nonce ${Math.random().toString(36).slice(2, 10)} issued at ${new Date().toISOString()}.`;
    const pos = Math.floor(Math.random() * (idx.length + 1));
    const order: number[] = [];
    const texts: string[] = [];
    for (let i = 0; i <= idx.length; i++) {
      if (i === pos) {
        order.push(-1);
        texts.push(nonceText);
      }
      if (i < idx.length) {
        order.push(idx[i]);
        texts.push(GOLDEN_TEXTS[idx[i]]);
      }
    }
    const id = newId('ch');
    const timer = setTimeout(() => {
      if (p.challenge?.id !== id) return;
      p.challenge = undefined;
      this.send(p.id, { type: 'challenge.failed', challengeId: id, reason: `no answer within ${this.ctx.config.challengeTimeoutMs} ms` });
      if (attempt < 3 && p.online) setTimeout(() => p.online && this.startChallenge(p, attempt + 1), 5000);
    }, this.ctx.config.challengeTimeoutMs);
    p.challenge = { id, order, sentAt: now(), timer, attempt };
    this.send(p.id, { type: 'challenge', challengeId: id, model: this.ctx.reference.model, texts, deadlineMs: this.ctx.config.challengeTimeoutMs });
  }

  private onChallengeResult(p: LiveProvider, msg: Extract<ProviderMessage, { type: 'challenge.result' }>): void {
    const ch = p.challenge;
    if (!ch || ch.id !== msg.challengeId) return;
    clearTimeout(ch.timer);
    p.challenge = undefined;
    const ref = this.ctx.reference;
    let minCos = 1;
    let reason: string | undefined;
    if (msg.embeddings.length !== ch.order.length) reason = `expected ${ch.order.length} vectors, got ${msg.embeddings.length}`;
    else {
      for (let i = 0; i < ch.order.length; i++) {
        const g = ch.order[i];
        if (g < 0) continue;
        const c = cosine(msg.embeddings[i], ref.vectors[g]);
        if (c < minCos) minCos = c;
      }
      if (minCos < this.ctx.config.verifyCosine) reason = `min cosine ${minCos.toFixed(4)} < ${this.ctx.config.verifyCosine}`;
    }
    if (reason) {
      console.log(`[providers] ${p.name} failed challenge: ${reason}`);
      this.send(p.id, { type: 'challenge.failed', challengeId: ch.id, reason });
      if (ch.attempt < 3) setTimeout(() => p.online && this.startChallenge(p, ch.attempt + 1), 5000);
      return;
    }
    p.tier = this.tierFor(p);
    this.ctx.repo.updateProvider(p.id, { tier: p.tier });
    console.log(`[providers] ${p.name} passed challenge (min cosine ${minCos.toFixed(4)}, ${now() - ch.sentAt} ms) → tier ${p.tier}`);
    if (this.ctx.config.credentials === 'off') {
      p.credential = { type: 'dev', status: 'accepted' };
      this.setStatus(p, 'verified');
      this.send(p.id, { type: 'verified', tier: p.tier });
      this.ctx.events.emit({ type: 'provider.verified', providerId: p.id, tier: p.tier, credential: { type: 'dev', issueTx: '', acceptTx: '' } });
      this.emitUtil(p);
    } else {
      void this.ctx.credentials.onboard(p);
    }
  }

  tierFor(p: LiveProvider): Tier {
    return p.benchmark.embedTps >= this.ctx.config.tierAEmbedTps && p.benchmark.genTps >= this.ctx.config.tierAGenTps ? 'A' : 'B';
  }

  private onHeartbeat(p: LiveProvider, msg: Extract<ProviderMessage, { type: 'heartbeat' }>): void {
    p.busySlots = msg.busySlots;
    p.queueDepth = msg.queueDepth;
    p.shade = msg.shade;
    p.surge = msg.surge;
    p.asks = msg.asks;
    p.draining = msg.draining;
    p.cheat = msg.cheat;
    if (!p.online) {
      p.online = true;
      this.ctx.events.emit({ type: 'provider.online', provider: this.view(p) });
    }
    this.emitUtil(p);
  }

  emitUtil(p: LiveProvider): void {
    this.ctx.events.emit({
      type: 'provider.util',
      providerId: p.id,
      busySlots: Math.max(p.busySlots, p.running) + p.reservations.size,
      slots: p.slots,
      queueDepth: p.queueDepth,
      shade: p.shade,
      surge: p.surge,
      asks: p.asks,
      draining: p.draining,
      cheat: p.cheat,
    });
  }

  markOffline(p: LiveProvider, why: string): void {
    if (!p.online) return;
    p.online = false;
    p.socket = undefined;
    if (p.challenge) {
      clearTimeout(p.challenge.timer);
      p.challenge = undefined;
    }
    this.ctx.repo.updateProvider(p.id, { last_seen: p.lastSeen });
    this.ctx.events.emit({ type: 'provider.offline', providerId: p.id });
    console.log(`[providers] offline: ${p.name} (${why})`);
  }

  private sweep(): void {
    const t = now();
    for (const p of this.providers.values()) {
      if (p.online && t - p.lastSeen > this.ctx.config.heartbeatTimeoutMs) {
        const s = p.socket;
        this.markOffline(p, `no heartbeat for ${t - p.lastSeen} ms`);
        if (s && s.readyState === s.OPEN) s.terminate();
      }
    }
  }

  // ---------------------------------------------------------------- rows
  private fromRow(r: ProviderRow): LiveProvider {
    const floors = JSON.parse(r.floors_json || '{}') as Partial<Hello['floors']>;
    const f = { embed: floors.embed ?? '0', generate: floors.generate ?? '0', streamDrops: floors.streamDrops ?? '0' };
    const cred = this.ctx.repo.latestCredential(r.id);
    return {
      id: r.id,
      name: r.name,
      region: r.region,
      hardware: JSON.parse(r.hardware_json || '{}') as Hello['hardware'],
      evmAddress: r.evm_address,
      xrplAddress: r.xrpl_address,
      xrplPublicKey: r.xrpl_public_key,
      models: JSON.parse(r.models_json || '[]') as string[],
      slots: r.slots,
      benchmark: JSON.parse(r.bench_json || '{}') as Hello['benchmark'],
      floors: f,
      status: (r.status === 'suspended' ? 'suspended' : 'offline') as ProviderStatus,
      tier: (r.tier as Tier | null) ?? undefined,
      strikes: r.strikes,
      earningsAusd: BigInt(r.earnings_ausd || '0'),
      earningsDrops: BigInt(r.earnings_drops || '0'),
      jobsDone: r.jobs_done,
      wins: 0,
      cheat: false,
      draining: false,
      online: false,
      lastSeen: r.last_seen ?? r.created_at,
      busySlots: 0,
      queueDepth: 0,
      shade: 1,
      surge: 1,
      asks: { embed: f.embed, generate: f.generate, stream: f.streamDrops },
      running: 0,
      reservations: new Map(),
      credential: cred
        ? { type: cred.credential_type, issueTx: cred.issue_tx ?? undefined, acceptTx: cred.accept_tx ?? undefined, deleteTx: cred.delete_tx ?? undefined, status: cred.status }
        : undefined,
      createdAt: r.created_at,
    };
  }
  private toRow(p: LiveProvider): ProviderRow {
    return {
      id: p.id,
      name: p.name,
      region: p.region,
      hardware_json: JSON.stringify(p.hardware),
      evm_address: p.evmAddress,
      xrpl_address: p.xrplAddress,
      xrpl_public_key: p.xrplPublicKey,
      models_json: JSON.stringify(p.models),
      slots: p.slots,
      bench_embed_tps: p.benchmark.embedTps,
      bench_gen_tps: p.benchmark.genTps,
      bench_json: JSON.stringify(p.benchmark),
      floors_json: JSON.stringify(p.floors),
      tier: p.tier ?? null,
      status: p.status,
      strikes: p.strikes,
      earnings_ausd: p.earningsAusd.toString(),
      earnings_drops: p.earningsDrops.toString(),
      jobs_done: p.jobsDone,
      created_at: p.createdAt,
      last_seen: p.lastSeen,
    };
  }
}
