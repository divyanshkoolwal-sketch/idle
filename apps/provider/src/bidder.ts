import type { Currency, JobType } from '@idle/shared';
import type { Floors } from './config';

export interface BidderOptions {
  floors: Floors;
  slots: number;
  embedTps: number; // texts / s
  genTps: number; // tokens / s
  cheat?: boolean;
  rng?: () => number; // injectable for tests
  /** outcomes needed before shade starts moving */
  minSamples?: number;
  windowSize?: number;
}

export interface Rfq {
  jobType: JobType;
  units: number;
  currency: Currency;
  maxUnitPrice: bigint;
  deadlineMs: number;
}

export interface Load {
  busySlots: number;
  reservedSlots: number;
  queueDepth: number;
}

export type BidDecision =
  | { kind: 'bid'; unitPrice: bigint; etaMs: number; shade: number; surge: number; floor: bigint }
  | { kind: 'pass'; reason: string };

export const SHADE_MIN = 1.0;
export const SHADE_MAX = 2.0;
export const CHEAT_DISCOUNT = 0.6; // bids 40% below floor
export const JITTER = 0.03;
export const NETWORK_MS = 150;

const scale = (x: bigint, m: number): bigint => BigInt(Math.max(1, Math.round(Number(x) * m)));

/**
 * Adaptive pricing agent (plan §6.4).
 *   u = busy/slots, surge = 1 + 1.5u², price = floor × surge × shade × (1 ± 3%), never below floor.
 *   shade learns from the last 10 auctions: winRate < 0.3 → ×0.95 (floor at 1.0), winRate > 0.6 → ×1.05 (cap 2.0).
 *   etaMs = queueDepth × avgJobMs + units / throughput × 1000 + 150.
 */
export class Bidder {
  shade = SHADE_MIN;
  cheat: boolean;
  private outcomes: boolean[] = [];
  private avgJobMs: Record<JobType, number>;
  private readonly rng: () => number;
  private readonly minSamples: number;
  private readonly windowSize: number;

  constructor(private readonly opts: BidderOptions) {
    this.cheat = opts.cheat ?? false;
    this.rng = opts.rng ?? Math.random;
    this.minSamples = opts.minSamples ?? 3;
    this.windowSize = opts.windowSize ?? 10;
    const embedMs = Math.max(100, (64 / Math.max(opts.embedTps, 0.1)) * 1000);
    const genMs = Math.max(100, (128 / Math.max(opts.genTps, 0.1)) * 1000);
    this.avgJobMs = { embed: embedMs, generate: genMs, stream: genMs };
  }

  floorFor(jobType: JobType, currency: Currency): bigint {
    if (currency === 'XRP' || jobType === 'stream') return this.opts.floors.streamDrops;
    return jobType === 'embed' ? this.opts.floors.embed : this.opts.floors.generate;
  }

  surge(busySlots: number): number {
    const u = Math.min(1, Math.max(0, busySlots / Math.max(1, this.opts.slots)));
    return 1 + 1.5 * u * u;
  }

  throughput(jobType: JobType): number {
    return Math.max(0.1, jobType === 'embed' ? this.opts.embedTps : this.opts.genTps);
  }

  eta(jobType: JobType, units: number, load: Load): number {
    return Math.round(load.queueDepth * this.avgJobMs[jobType] + (units / this.throughput(jobType)) * 1000 + NETWORK_MS);
  }

  /** Current ask without jitter — what the dashboard shows as "current ask". */
  ask(jobType: JobType, currency: Currency, busySlots: number): bigint {
    const floor = this.floorFor(jobType, currency);
    if (this.cheat) return scale(floor, CHEAT_DISCOUNT);
    const p = scale(floor, this.surge(busySlots) * this.shade);
    return p < floor ? floor : p;
  }

  decide(rfq: Rfq, load: Load): BidDecision {
    const free = this.opts.slots - load.busySlots - load.reservedSlots;
    if (free <= 0) return { kind: 'pass', reason: 'no free slot' };
    const etaMs = this.eta(rfq.jobType, rfq.units, load);
    if (etaMs > rfq.deadlineMs) return { kind: 'pass', reason: `eta ${etaMs}ms exceeds deadline ${rfq.deadlineMs}ms` };
    const floor = this.floorFor(rfq.jobType, rfq.currency);
    const surge = this.surge(load.busySlots);
    const jitter = 1 + (this.rng() * 2 - 1) * JITTER;
    let unitPrice: bigint;
    if (this.cheat) {
      unitPrice = scale(floor, CHEAT_DISCOUNT * jitter);
    } else {
      unitPrice = scale(floor, surge * this.shade * jitter);
      if (unitPrice < floor) unitPrice = floor;
    }
    return { kind: 'bid', unitPrice, etaMs, shade: round3(this.shade), surge: round3(surge), floor };
  }

  /** Feed an auction outcome (award = true, lose = false). */
  record(won: boolean): void {
    this.outcomes.push(won);
    if (this.outcomes.length > this.windowSize) this.outcomes.shift();
    if (this.outcomes.length < this.minSamples) return;
    const winRate = this.outcomes.filter(Boolean).length / this.outcomes.length;
    if (winRate < 0.3) this.shade = Math.max(SHADE_MIN, this.shade * 0.95);
    else if (winRate > 0.6) this.shade = Math.min(SHADE_MAX, this.shade * 1.05);
  }

  /** Learn real job durations (EMA) so ETAs stay honest. */
  recordJobMs(jobType: JobType, ms: number): void {
    this.avgJobMs[jobType] = Math.round(0.7 * this.avgJobMs[jobType] + 0.3 * ms);
  }

  get winRate(): number {
    return this.outcomes.length ? this.outcomes.filter(Boolean).length / this.outcomes.length : 0;
  }
  get samples(): number {
    return this.outcomes.length;
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
