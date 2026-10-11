import { signHelloProof } from '@idle/pay-xrpl';
import { decodeCredentialType } from './credential';
import { acceptCredential, disconnectXrpl } from '@idle/pay-xrpl';
import { xrplTx } from '@idle/shared';
import type { Currency, JobType } from '@idle/shared';
import { Bidder } from './bidder';
import type { ProviderConfig } from './config';
import type { ExchangeConnection } from './connection';
import type { Ollama } from './ollama';
import { StreamSession } from './stream';
import { randomUnitVector } from './vectors';
import type { ProviderWallets } from './wallets';
import { readProviderId, saveProviderId } from './wallets';
import type { Benchmark, Hardware, Inbound, InboundOf, Outbound } from './types';
import type { Logger } from './log';

type JobMsg = InboundOf<'job'>;

export interface DaemonDeps {
  cfg: ProviderConfig;
  wallets: ProviderWallets;
  hardware: Hardware;
  benchmark: Benchmark & { embedDim?: number };
  ollama: Ollama;
  conn: ExchangeConnection;
  log: Logger;
  heartbeatMs?: number;
  genNumGpu?: number;
  embedNumGpu?: number;
}

export class ProviderDaemon {
  providerId?: string;
  status: 'connecting' | 'pending' | 'verified' | 'suspended' | 'draining' | 'offline' = 'connecting';
  tier?: 'A' | 'B';
  issuer?: string;
  cheat: boolean;
  draining = false;
  readonly bidder: Bidder;
  private running = new Map<string, JobMsg>();
  private queue: JobMsg[] = [];
  private reservations = new Map<string, NodeJS.Timeout>();
  private streams = new Map<string, StreamSession>();
  private heartbeat?: NodeJS.Timeout;
  private embedDim: number;
  private drainPromise?: Promise<void>;
  /** Called once the daemon has drained and disconnected (exchange- or signal-initiated). */
  onDrained?: (reason: string) => void;

  constructor(private readonly d: DaemonDeps) {
    this.cheat = d.cfg.cheat;
    this.embedDim = d.benchmark.embedDim ?? 768;
    this.bidder = new Bidder({ floors: d.cfg.floors, slots: d.cfg.slots, embedTps: d.benchmark.embedTps, genTps: d.benchmark.genTps, cheat: this.cheat });
    this.providerId = readProviderId();
  }

  get busySlots(): number {
    return this.running.size + this.streams.size;
  }
  get reservedSlots(): number {
    return this.reservations.size;
  }
  get freeSlots(): number {
    return Math.max(0, this.d.cfg.slots - this.busySlots - this.reservedSlots);
  }

  start(): void {
    const { conn, log } = this.d;
    conn.on('open', () => {
      this.status = 'pending';
      this.sendHello();
      this.startHeartbeat();
    });
    conn.on('close', (code, reason) => {
      this.stopHeartbeat();
      if (!this.draining) log.warn(`disconnected (${code}${reason ? ' ' + reason : ''})`);
      // reservations are meaningless after a disconnect; running jobs finish and report on reconnect (best effort)
      for (const t of this.reservations.values()) clearTimeout(t);
      this.reservations.clear();
    });
    conn.on('message', (m) => {
      this.handle(m).catch((e) => log.error(`handling ${m.type}: ${(e as Error).message}`));
    });
    conn.connect();
  }

  /** Stop bidding, finish running work, then disconnect. Resolves when the socket is closed. */
  drain(reason = 'drain'): Promise<void> {
    if (!this.drainPromise) this.drainPromise = this.doDrain(reason);
    return this.drainPromise;
  }

  private async doDrain(reason: string): Promise<void> {
    this.draining = true;
    this.status = 'draining';
    this.d.log.info(`draining (${reason}): no new bids; finishing ${this.running.size} job(s) and ${this.streams.size} stream(s)`);
    for (const t of this.reservations.values()) clearTimeout(t);
    this.reservations.clear();
    this.sendHeartbeat();
    const deadline = Date.now() + 120_000;
    while ((this.running.size > 0 || this.streams.size > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    this.sendHeartbeat();
    this.stopHeartbeat();
    this.status = 'offline';
    this.d.conn.close(1000, reason);
    await disconnectXrpl().catch(() => undefined);
    this.onDrained?.(reason);
  }

  undrain(): void {
    if (!this.draining || this.status === 'offline') return;
    this.draining = false;
    this.drainPromise = undefined;
    this.status = this.tier ? 'verified' : 'pending';
    this.d.log.info('drain cancelled; bidding again');
  }

  setCheat(on: boolean): void {
    this.cheat = on;
    this.bidder.cheat = on;
    this.d.log.warn(`cheat mode ${on ? 'ON (bidding below floor, returning random vectors)' : 'off'}`);
  }

  // ---------------------------------------------------------------- outbound

  private send(m: Outbound): void {
    if (!this.d.conn.send(m)) this.d.log.debug(`dropped ${m.type} (socket closed)`);
  }

  private sendHello(): void {
    const { cfg, wallets, hardware, benchmark } = this.d;
    this.send({
      type: 'hello',
      providerId: this.providerId,
      name: cfg.name,
      region: cfg.region,
      hardware,
      evmAddress: wallets.evmAddress,
      xrplAddress: wallets.xrpl.address,
      xrplPublicKey: wallets.xrpl.publicKey,
      models: [cfg.embedModel, cfg.genModel],
      slots: cfg.slots,
      benchmark: { embedTps: benchmark.embedTps, genTps: benchmark.genTps, embedMs: benchmark.embedMs, genMs: benchmark.genMs },
      floors: { embed: cfg.floors.embed.toString(), generate: cfg.floors.generate.toString(), streamDrops: cfg.floors.streamDrops.toString() },
      cheat: this.cheat,
      version: '0.1.0',
      proof: signHelloProof(wallets.xrpl, wallets.evmAddress),
    });
  }

  private asks() {
    const b = this.busySlots;
    return {
      embed: this.bidder.ask('embed', 'AUSD', b).toString(),
      generate: this.bidder.ask('generate', 'AUSD', b).toString(),
      stream: this.bidder.ask('stream', 'XRP', b).toString(),
    };
  }

  private sendHeartbeat(): void {
    this.send({
      type: 'heartbeat',
      busySlots: this.busySlots,
      queueDepth: this.queue.length,
      shade: round3(this.bidder.shade),
      surge: round3(this.bidder.surge(this.busySlots)),
      asks: this.asks(),
      draining: this.draining,
      cheat: this.cheat,
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.sendHeartbeat(), this.d.heartbeatMs ?? 1000);
    this.sendHeartbeat();
  }
  private stopHeartbeat(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  // ----------------------------------------------------------------- inbound

  private async handle(m: Inbound): Promise<void> {
    const { log } = this.d;
    switch (m.type) {
      case 'welcome': {
        if (m.providerId !== this.providerId) {
          this.providerId = m.providerId;
          saveProviderId(m.providerId);
        }
        this.issuer = m.issuerAddress;
        if (m.status === 'verified') {
          this.status = 'verified';
          this.tier = m.tier;
        } else if (m.status === 'suspended') this.status = 'suspended';
        log.info(`welcome: providerId=${m.providerId} status=${m.status}${m.tier ? ` tier=${m.tier}` : ''} issuer=${m.issuerAddress}`);
        return;
      }
      case 'challenge': {
        // Always answered honestly: the point of cheat mode is to be caught by spot checks after onboarding.
        const t0 = Date.now();
        try {
          const { embeddings } = await this.d.ollama.embed(m.model, m.texts, { numGpu: this.d.embedNumGpu });
          this.embedDim = embeddings[0]?.length ?? this.embedDim;
          this.send({ type: 'challenge.result', challengeId: m.challengeId, embeddings, ms: Date.now() - t0 });
          log.info(`challenge ${m.challengeId}: embedded ${m.texts.length} texts in ${Date.now() - t0} ms`);
        } catch (e) {
          log.error(`challenge failed: ${(e as Error).message}`);
          this.send({ type: 'challenge.result', challengeId: m.challengeId, embeddings: [], ms: Date.now() - t0 });
        }
        return;
      }
      case 'challenge.failed':
        log.warn(`challenge ${m.challengeId} failed: ${m.reason}`);
        return;
      case 'credential.offered': {
        const type = decodeCredentialType(m.credentialType);
        log.info(`credential offered: ${type} (tier ${m.tier}) issued in ${xrplTx(m.txHash)}; accepting on-ledger…`);
        try {
          const { txHash } = await acceptCredential(this.d.wallets.xrpl, m.issuer, type);
          log.info(`CredentialAccept ${xrplTx(txHash)}`);
          this.send({ type: 'credential.accepted', txHash });
        } catch (e) {
          log.error(`CredentialAccept failed: ${(e as Error).message}`);
        }
        return;
      }
      case 'verified':
        this.status = this.draining ? 'draining' : 'verified';
        this.tier = m.tier;
        log.info(`verified as Tier ${m.tier} — eligible to bid`);
        return;
      case 'rfq': {
        if (this.draining) return void this.send({ type: 'pass', auctionId: m.auctionId, reason: 'draining' });
        const decision = this.bidder.decide(
          { jobType: m.jobType, units: m.units, currency: m.currency, maxUnitPrice: BigInt(m.maxUnitPrice), deadlineMs: m.deadlineMs },
          { busySlots: this.busySlots, reservedSlots: this.reservedSlots, queueDepth: this.queue.length },
        );
        if (decision.kind === 'pass') {
          this.send({ type: 'pass', auctionId: m.auctionId, reason: decision.reason });
          log.debug(`rfq ${m.auctionId}: pass (${decision.reason})`);
        } else {
          this.send({ type: 'bid', auctionId: m.auctionId, unitPrice: decision.unitPrice.toString(), etaMs: decision.etaMs, shade: decision.shade, surge: decision.surge });
          log.info(`rfq ${m.auctionId}: bid ${decision.unitPrice} ${m.currency === 'XRP' ? 'drops' : 'µAUSD'}/unit (floor ${decision.floor}, surge ${decision.surge}, shade ${decision.shade}) eta ${decision.etaMs} ms`);
        }
        return;
      }
      case 'award': {
        this.bidder.record(true);
        const ttl = Math.max(0, m.quoteExpiresAt - Date.now());
        clearTimeout(this.reservations.get(m.auctionId));
        this.reservations.set(
          m.auctionId,
          setTimeout(() => {
            this.reservations.delete(m.auctionId);
            log.debug(`reservation ${m.auctionId} expired`);
          }, ttl),
        );
        log.info(`award ${m.auctionId}: clearing ${m.clearingUnitPrice}; slot reserved ${Math.round(ttl / 1000)} s`);
        return;
      }
      case 'lose':
        this.bidder.record(false);
        log.debug(`lose ${m.auctionId}${m.clearingUnitPrice ? ` (cleared at ${m.clearingUnitPrice})` : ''}`);
        return;
      case 'release':
        clearTimeout(this.reservations.get(m.auctionId));
        this.reservations.delete(m.auctionId);
        return;
      case 'job':
        clearTimeout(this.reservations.get(m.auctionId));
        this.reservations.delete(m.auctionId);
        this.enqueue(m);
        return;
      case 'stream.start': {
        const session = new StreamSession(m, {
          ollama: this.d.ollama,
          wallet: this.d.wallets.xrpl,
          send: (o) => this.send(o),
          log,
          temperature: this.d.cfg.genTemperature,
          numGpu: this.d.genNumGpu,
        });
        this.streams.set(m.streamId, session);
        session
          .run()
          .catch((e) => log.error(`stream ${m.streamId}: ${(e as Error).message}`))
          .finally(() => this.streams.delete(m.streamId));
        return;
      }
      case 'stream.claim': {
        const s = this.streams.get(m.streamId);
        if (!s) return void log.debug(`claim for unknown stream ${m.streamId}`);
        const r = s.onClaim(BigInt(m.amountDrops), m.signature);
        if (!r.ok) log.debug(`claim rejected: ${r.reason}`);
        return;
      }
      case 'stream.stop':
        this.streams.get(m.streamId)?.stop();
        return;
      case 'drain':
        if (m.on) void this.drain('exchange');
        else this.undrain();
        return;
      case 'cheat':
        this.setCheat(m.on);
        return;
      case 'error':
        log.warn(`exchange error ${m.code}: ${m.message}`);
        return;
    }
  }

  // -------------------------------------------------------------------- jobs

  private enqueue(job: JobMsg): void {
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.queue.length > 0 && this.busySlots < this.d.cfg.slots) {
      const job = this.queue.shift()!;
      this.running.set(job.jobId, job);
      this.runJob(job)
        .catch((e) => this.d.log.error(`job ${job.jobId}: ${(e as Error).message}`))
        .finally(() => {
          this.running.delete(job.jobId);
          this.pump();
        });
    }
  }

  private async runJob(job: JobMsg): Promise<void> {
    const { log, ollama } = this.d;
    const t0 = Date.now();
    try {
      if (job.jobType === 'embed') {
        const texts = job.input.texts ?? [];
        if (texts.length === 0) throw new Error('embed job has no texts');
        let embeddings: number[][];
        if (this.cheat) {
          embeddings = texts.map(() => randomUnitVector(this.embedDim));
          await new Promise((r) => setTimeout(r, 30)); // cheap work is suspiciously fast; keep a token delay
        } else {
          const r = await ollama.embed(job.model, texts, { numGpu: this.d.embedNumGpu });
          embeddings = r.embeddings;
          this.embedDim = embeddings[0]?.length ?? this.embedDim;
        }
        const ms = Date.now() - t0;
        this.bidder.recordJobMs('embed', ms);
        this.send({ type: 'result', jobId: job.jobId, ok: true, output: { embeddings }, ms });
        log.info(`job ${job.jobId}: embed ${texts.length} texts in ${ms} ms${this.cheat ? ' (CHEAT: random vectors)' : ''}`);
      } else if (job.jobType === 'generate') {
        const prompt = job.input.prompt ?? '';
        if (!prompt) throw new Error('generate job has no prompt');
        const r = await ollama.generate(job.model, prompt, { maxTokens: job.input.maxTokens ?? 128, temperature: this.d.cfg.genTemperature, numGpu: this.d.genNumGpu });
        const ms = Date.now() - t0;
        this.bidder.recordJobMs('generate', ms);
        this.send({ type: 'result', jobId: job.jobId, ok: true, output: { text: r.text, tokens: r.tokens }, ms });
        log.info(`job ${job.jobId}: generated ${r.tokens} tokens in ${ms} ms`);
      } else {
        throw new Error(`job type ${job.jobType} must use the stream protocol`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      log.error(`job ${job.jobId} failed: ${msg}`);
      this.send({ type: 'result', jobId: job.jobId, ok: false, error: msg });
    }
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
export type { Currency, JobType };
