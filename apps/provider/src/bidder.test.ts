import { describe, expect, it } from 'vitest';
import { Bidder, CHEAT_DISCOUNT, SHADE_MAX, SHADE_MIN } from './bidder';

const floors = { embed: 15n, generate: 25n, streamDrops: 40n };
const mk = (over: Partial<ConstructorParameters<typeof Bidder>[0]> = {}) =>
  new Bidder({ floors, slots: 2, embedTps: 50, genTps: 20, rng: () => 0.5, ...over }); // rng 0.5 → jitter 1.0

const idle = { busySlots: 0, reservedSlots: 0, queueDepth: 0 };
const rfq = { jobType: 'embed' as const, units: 32, currency: 'AUSD' as const, maxUnitPrice: 1000n, deadlineMs: 10_000 };

describe('surge', () => {
  it('is 1 when idle and 2.5 when saturated', () => {
    const b = mk();
    expect(b.surge(0)).toBe(1);
    expect(b.surge(1)).toBeCloseTo(1.375);
    expect(b.surge(2)).toBeCloseTo(2.5);
  });
});

describe('decide', () => {
  it('bids exactly the floor when idle with shade 1', () => {
    const d = mk().decide(rfq, idle);
    expect(d.kind).toBe('bid');
    if (d.kind === 'bid') {
      expect(d.unitPrice).toBe(15n);
      expect(d.surge).toBe(1);
      expect(d.shade).toBe(1);
    }
  });
  it('raises the price with load', () => {
    const d = mk().decide(rfq, { busySlots: 1, reservedSlots: 0, queueDepth: 0 });
    if (d.kind !== 'bid') throw new Error('expected bid');
    expect(d.unitPrice).toBe(21n); // 15 × 1.375 = 20.6 → 21
  });
  it('never goes below floor even with negative jitter', () => {
    const d = mk({ rng: () => 0 }).decide(rfq, idle); // jitter 0.97
    if (d.kind !== 'bid') throw new Error('expected bid');
    expect(d.unitPrice).toBe(15n);
  });
  it('jitter stays within ±3%', () => {
    const hi = mk({ rng: () => 1 }).decide({ ...rfq, jobType: 'generate' }, idle);
    if (hi.kind !== 'bid') throw new Error('expected bid');
    expect(hi.unitPrice).toBe(26n); // 25 × 1.03 = 25.75 → 26
    const loaded = mk({ rng: () => 1, slots: 4 }).decide({ ...rfq, jobType: 'generate' }, { busySlots: 2, reservedSlots: 0, queueDepth: 0 });
    if (loaded.kind !== 'bid') throw new Error('expected bid');
    expect(loaded.unitPrice).toBe(35n); // 25 × 1.375 × 1.03 = 35.4 → 35
  });
  it('uses the drops floor for XRP streams', () => {
    const d = mk().decide({ ...rfq, jobType: 'stream', currency: 'XRP', units: 256, deadlineMs: 30_000 }, idle);
    if (d.kind !== 'bid') throw new Error('expected bid');
    expect(d.unitPrice).toBe(40n);
  });
  it('passes when there is no free slot (busy + reserved)', () => {
    expect(mk().decide(rfq, { busySlots: 1, reservedSlots: 1, queueDepth: 0 }).kind).toBe('pass');
    expect(mk().decide(rfq, { busySlots: 2, reservedSlots: 0, queueDepth: 0 }).kind).toBe('pass');
  });
  it('passes when the ETA exceeds the deadline', () => {
    const d = mk().decide({ ...rfq, deadlineMs: 100 }, idle); // 32/50×1000 + 150 = 790 > 100
    expect(d).toEqual({ kind: 'pass', reason: expect.stringContaining('exceeds deadline') });
  });
  it('eta accounts for queue depth and throughput', () => {
    const b = mk();
    expect(b.eta('embed', 32, idle)).toBe(790);
    expect(b.eta('embed', 32, { ...idle, queueDepth: 1 })).toBe(790 + 1280); // avg embed job = 64/50 s
  });
  it('cheat mode bids 40% below floor regardless of load', () => {
    const b = mk({ cheat: true });
    const d = b.decide(rfq, { busySlots: 1, reservedSlots: 0, queueDepth: 0 });
    if (d.kind !== 'bid') throw new Error('expected bid');
    expect(d.unitPrice).toBe(9n); // 15 × 0.6
    expect(Number(d.unitPrice)).toBeCloseTo(Number(floors.embed) * CHEAT_DISCOUNT, 0);
    expect(b.ask('embed', 'AUSD', 2)).toBe(9n);
  });
});

describe('shade learning', () => {
  it('does not move before minSamples', () => {
    const b = mk();
    b.record(false);
    b.record(false);
    expect(b.shade).toBe(1);
  });
  it('shades down on losses but never below 1.0', () => {
    const b = mk();
    for (let i = 0; i < 10; i++) b.record(false);
    expect(b.shade).toBe(SHADE_MIN);
  });
  it('shades up on wins, capped at 2.0', () => {
    const b = mk();
    for (let i = 0; i < 3; i++) b.record(true);
    expect(b.shade).toBeCloseTo(1.05);
    for (let i = 0; i < 40; i++) b.record(true);
    expect(b.shade).toBe(SHADE_MAX);
    const d = b.decide(rfq, idle);
    if (d.kind !== 'bid') throw new Error('expected bid');
    expect(d.unitPrice).toBe(30n);
  });
  it('comes back down after a winning streak turns into losses', () => {
    const b = mk();
    for (let i = 0; i < 10; i++) b.record(true);
    const peak = b.shade;
    for (let i = 0; i < 10; i++) b.record(false);
    expect(b.shade).toBeLessThan(peak);
    expect(b.winRate).toBe(0);
  });
  it('only looks at the last 10 outcomes', () => {
    const b = mk();
    for (let i = 0; i < 10; i++) b.record(false);
    for (let i = 0; i < 10; i++) b.record(true);
    expect(b.winRate).toBe(1);
    expect(b.samples).toBe(10);
  });
});

describe('ask', () => {
  it('reflects surge × shade without jitter', () => {
    const b = mk();
    expect(b.ask('embed', 'AUSD', 0)).toBe(15n);
    expect(b.ask('generate', 'AUSD', 2)).toBe(63n); // 25 × 2.5 = 62.5 → 63
    expect(b.ask('stream', 'XRP', 0)).toBe(40n);
  });
});
