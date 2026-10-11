import type { Wallet } from 'xrpl';
import { getChannel, submitClaim, verifyClaim } from '@idle/pay-xrpl';
import { xrplTx } from '@idle/shared';
import type { Ollama } from './ollama';
import type { InboundOf, Outbound } from './types';
import type { Logger } from './log';

export interface StreamDeps {
  ollama: Ollama;
  wallet: Wallet; // our XRPL wallet (channel destination)
  send: (m: Outbound) => void;
  log: Logger;
  creditWindow?: number; // max unpaid tokens before pausing
  finalClaimGraceMs?: number; // how long to wait for the buyer's final claim after `end`
  creditTimeoutMs?: number; // how long to stay paused before giving up
  temperature?: number;
  numGpu?: number;
}

type StartMsg = InboundOf<'stream.start'>;

/**
 * Highest claim we have ever verified per channel (process memory). The baseline for a new stream is
 * max(priorClaimedDrops the exchange tells us, our own record), so a buyer cannot restart from a lower prior.
 */
const channelHighWater = new Map<string, { drops: bigint; signature: string }>();
export const getChannelHighWater = (channelId: string) => channelHighWater.get(channelId);

/**
 * One XRPL-metered generation (plan §6.7, provider side).
 * Every token is counted; the buyer's cumulative claims are verified off-ledger; the highest
 * valid claim is redeemed on-ledger with PaymentChannelClaim when the stream ends.
 */
export class StreamSession {
  readonly streamId: string;
  readonly channelId: string;
  readonly dropsPerToken: bigint;
  readonly prior: bigint;
  tokensDelivered = 0;
  highestDrops: bigint;
  highestSig?: string;
  private paused = false;
  private stopped = false;
  private ended = false;
  private readonly abort = new AbortController();
  private wake?: () => void;
  private finalWake?: () => void;
  private readonly window: number;
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(private readonly start: StartMsg, private readonly deps: StreamDeps) {
    this.streamId = start.streamId;
    this.channelId = start.channelId;
    this.dropsPerToken = BigInt(start.dropsPerToken);
    const told = BigInt(start.priorClaimedDrops);
    const record = channelHighWater.get(start.channelId);
    this.prior = record && record.drops > told ? record.drops : told;
    this.highestDrops = this.prior;
    if (record && record.drops > told) {
      deps.log.warn(`stream ${start.streamId}: exchange says prior ${told} drops but we hold a claim for ${record.drops}; using ours`);
    }
    this.window = deps.creditWindow ?? 32;
    this.done = new Promise<void>((r) => (this.resolveDone = r));
  }

  /** tokens delivered but not yet covered by a valid claim */
  get unpaidTokens(): number {
    const paid = Number((this.highestDrops - this.prior) / this.dropsPerToken);
    return this.tokensDelivered - paid;
  }
  get owedDrops(): bigint {
    return this.prior + BigInt(this.tokensDelivered) * this.dropsPerToken;
  }
  get isActive(): boolean {
    return !this.ended;
  }

  async run(): Promise<void> {
    const { log, send } = this.deps;
    let reason: 'done' | 'stopped' | 'error' | 'unpaid' = 'done';
    let error: string | undefined;
    try {
      const problem = await this.verifyChannel();
      if (problem) {
        log.warn(`stream ${this.streamId}: channel rejected: ${problem}`);
        this.ended = true;
        send({ type: 'stream.end', streamId: this.streamId, tokensDelivered: 0, reason: 'error', error: problem });
        return;
      }
      log.info(`stream ${this.streamId}: start (channel ${this.channelId.slice(0, 8)}…, ${this.dropsPerToken} drops/token, prior ${this.prior})`);
      const gen = this.deps.ollama.generateStream(this.start.model, this.start.prompt, { maxTokens: this.start.maxTokens, temperature: this.deps.temperature, numGpu: this.deps.numGpu }, this.abort.signal);
      for (;;) {
        const next = await gen.next();
        if (next.done) break;
        if (this.stopped) break;
        const { token, index } = next.value;
        this.tokensDelivered++;
        send({ type: 'stream.token', streamId: this.streamId, token, index });
        if (this.unpaidTokens > this.window) {
          const ok = await this.waitForCredit();
          if (!ok) {
            reason = this.stopped ? 'stopped' : 'unpaid';
            break;
          }
        }
      }
      if (this.stopped && reason === 'done') reason = 'stopped';
    } catch (e) {
      if (this.stopped) reason = 'stopped';
      else {
        reason = 'error';
        error = (e as Error).message;
        log.warn(`stream ${this.streamId}: ${error}`);
      }
    }
    this.ended = true;
    send({ type: 'stream.end', streamId: this.streamId, tokensDelivered: this.tokensDelivered, reason, error });
    log.info(`stream ${this.streamId}: end (${reason}) ${this.tokensDelivered} tokens, owed ${this.owedDrops} drops, claimed ${this.highestDrops}`);
    await this.waitForFinalClaim();
    await this.settle();
    this.resolveDone();
  }

  /** Buyer claim relayed by the exchange. Keeps the highest valid cumulative claim. */
  onClaim(amountDrops: bigint, signature: string): { ok: boolean; reason?: string } {
    if (amountDrops <= this.highestDrops) return { ok: false, reason: `claim ${amountDrops} not above current ${this.highestDrops}` };
    if (!verifyClaim(this.channelId, amountDrops, signature, this.start.buyerPublicKey)) {
      this.deps.log.warn(`stream ${this.streamId}: invalid claim signature for ${amountDrops} drops`);
      return { ok: false, reason: 'bad signature' };
    }
    this.highestDrops = amountDrops;
    this.highestSig = signature;
    channelHighWater.set(this.channelId, { drops: amountDrops, signature });
    this.deps.log.debug(`stream ${this.streamId}: claim ok ${amountDrops} drops (unpaid ${this.unpaidTokens})`);
    if (this.paused && this.unpaidTokens <= this.window) this.wake?.();
    if (this.finalWake) this.finalWake(); // any claim after `end` is the buyer's final one
    return { ok: true };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.wake?.();
  }

  private async verifyChannel(): Promise<string | undefined> {
    let ch;
    try {
      ch = await getChannel(this.channelId);
    } catch (e) {
      return `ledger lookup failed: ${(e as Error).message}`;
    }
    if (!ch) return 'channel not found on ledger';
    if (ch.destination !== this.deps.wallet.address) return `channel destination ${ch.destination} is not this provider`;
    if (ch.account !== this.start.buyerAddress) return `channel owner ${ch.account} is not the buyer`;
    if ((ch.publicKey ?? '').toUpperCase() !== this.start.buyerPublicKey.toUpperCase()) return 'channel public key does not match buyer';
    if (ch.expiration !== undefined) return 'channel is expiring';
    const committed = ch.balanceDrops > this.prior ? ch.balanceDrops : this.prior;
    const remaining = ch.amountDrops - committed;
    const need = BigInt(this.window) * this.dropsPerToken;
    if (remaining < need) return `channel has ${remaining} drops free, need at least ${need}`;
    return undefined;
  }

  /** Paused until a newer claim brings unpaid tokens back inside the window. */
  private waitForCredit(): Promise<boolean> {
    this.paused = true;
    this.deps.send({ type: 'stream.paused', streamId: this.streamId, unpaidTokens: this.unpaidTokens });
    this.deps.log.info(`stream ${this.streamId}: paused, ${this.unpaidTokens} unpaid tokens`);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), this.deps.creditTimeoutMs ?? 60_000);
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        this.paused = false;
        this.wake = undefined;
        resolve(ok && !this.stopped);
      };
      this.wake = () => finish(this.unpaidTokens <= this.window);
    });
  }

  /**
   * After `end`, wait up to ~2.5 s for one more claim: the agent signs its final cumulative claim
   * (covering the last < 16 tokens) only after it sees `end`.
   */
  private waitForFinalClaim(): Promise<void> {
    if (this.highestDrops >= this.owedDrops) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.finalWake = undefined;
        resolve();
      }, this.deps.finalClaimGraceMs ?? 2500);
      this.finalWake = () => {
        clearTimeout(timer);
        this.finalWake = undefined;
        resolve();
      };
    });
  }

  private async settle(): Promise<void> {
    const { log, send } = this.deps;
    if (this.highestDrops <= this.prior || !this.highestSig) {
      log.info(`stream ${this.streamId}: nothing to claim on-ledger`);
      return;
    }
    if (this.highestDrops < this.owedDrops) {
      log.warn(`stream ${this.streamId}: buyer's final claim (${this.highestDrops}) is short of ${this.owedDrops} owed drops; claiming what was signed`);
    }
    try {
      const { txHash } = await submitClaim(this.deps.wallet, this.channelId, this.highestDrops, this.highestSig, this.start.buyerPublicKey);
      log.info(`stream ${this.streamId}: PaymentChannelClaim ${this.highestDrops} drops for ${this.tokensDelivered} tokens ${xrplTx(txHash)}`);
      send({ type: 'stream.claimed', streamId: this.streamId, txHash, drops: this.highestDrops.toString(), tokens: this.tokensDelivered });
    } catch (e) {
      log.error(`stream ${this.streamId}: PaymentChannelClaim failed: ${(e as Error).message}`);
    }
  }
}
