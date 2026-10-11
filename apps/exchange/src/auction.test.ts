import { describe, expect, it } from 'vitest';
import { clearAuction, type BidInput } from './auction';

const bid = (providerId: string, unitPrice: bigint, etaMs = 500, reputation = 0, receivedAt = 0): BidInput => ({ providerId, unitPrice, etaMs, reputation, receivedAt });

describe('clearAuction (sealed-bid second price)', () => {
  it('charges the second-lowest valid price', () => {
    const r = clearAuction([bid('a', 10n), bid('b', 14n), bid('c', 20n)], 30n, 5000);
    expect(r.winner?.providerId).toBe('a');
    expect(r.clearingUnitPrice).toBe(14n);
  });

  it('a single valid bidder pays its own bid', () => {
    const r = clearAuction([bid('a', 12n)], 30n, 5000);
    expect(r.winner?.providerId).toBe('a');
    expect(r.clearingUnitPrice).toBe(12n);
    expect(r.valid).toHaveLength(1);
  });

  it('returns no winner when every bid is invalid', () => {
    const r = clearAuction([bid('a', 40n), bid('b', 10n, 9000)], 30n, 5000);
    expect(r.winner).toBeUndefined();
    expect(r.clearingUnitPrice).toBeUndefined();
    expect(r.invalid.map((i) => i.reason).sort()).toEqual(['above_max_unit_price', 'eta_exceeds_deadline']);
  });

  it('returns no winner when there are no bids', () => {
    const r = clearAuction([], 30n, 5000);
    expect(r.winner).toBeUndefined();
    expect(r.valid).toHaveLength(0);
  });

  it('filters by deadline: a cheaper but slow bid loses and does not set the price', () => {
    const r = clearAuction([bid('slow', 5n, 8000), bid('a', 12n, 400), bid('b', 15n, 300)], 30n, 5000);
    expect(r.winner?.providerId).toBe('a');
    expect(r.clearingUnitPrice).toBe(15n);
    expect(r.invalid[0].bid.providerId).toBe('slow');
  });

  it('above-max bids are excluded from second-price math', () => {
    const r = clearAuction([bid('a', 10n), bid('b', 35n)], 30n, 5000);
    expect(r.winner?.providerId).toBe('a');
    expect(r.clearingUnitPrice).toBe(10n);
  });

  it('breaks price ties by ETA, then reputation, then arrival', () => {
    const r1 = clearAuction([bid('a', 10n, 900), bid('b', 10n, 300)], 30n, 5000);
    expect(r1.winner?.providerId).toBe('b');
    expect(r1.clearingUnitPrice).toBe(10n);
    const r2 = clearAuction([bid('a', 10n, 300, 1), bid('b', 10n, 300, 5)], 30n, 5000);
    expect(r2.winner?.providerId).toBe('b');
    const r3 = clearAuction([bid('a', 10n, 300, 2, 100), bid('b', 10n, 300, 2, 50)], 30n, 5000);
    expect(r3.winner?.providerId).toBe('b');
  });

  it('never clears above maxUnitPrice', () => {
    const r = clearAuction([bid('a', 10n), bid('b', 30n)], 30n, 5000);
    expect(r.clearingUnitPrice).toBe(30n);
    expect(r.clearingUnitPrice! <= 30n).toBe(true);
  });

  it('uses bigint throughout (no float drift on large atomic amounts)', () => {
    const big = 123456789012345678901234567890n;
    const r = clearAuction([bid('a', big - 1n), bid('b', big)], big, 5000);
    expect(r.clearingUnitPrice).toBe(big);
  });
});
