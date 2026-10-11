import type { AuctionView, BidView, Currency, JobType, Tier } from '@idle/shared';
import type { Ctx } from './context';
import type { LiveProvider } from './providers';
import type { AuctionRow, BidRow } from './db/repo';
import { auctionView } from './views';
import { newId, now } from './ids';
import type { ProviderMessage } from '@idle/shared';

export interface BidInput {
  providerId: string;
  unitPrice: bigint;
  etaMs: number;
  reputation: number;
  receivedAt: number;
  shade?: number;
  surge?: number;
}
export interface ClearResult {
  valid: BidInput[];
  invalid: { bid: BidInput; reason: string }[];
  winner?: BidInput;
  clearingUnitPrice?: bigint;
}

/**
 * Sealed-bid second-price clearing (pure).
 * valid = price ≤ max AND eta ≤ deadline; sort by (price asc, eta asc, reputation desc, arrival asc);
 * clearing = min(second-lowest valid price, max) or the winner's own price when it is the only valid bid.
 */
export function clearAuction(bids: BidInput[], maxUnitPrice: bigint, deadlineMs: number): ClearResult {
  const valid: BidInput[] = [];
  const invalid: ClearResult['invalid'] = [];
  for (const b of bids) {
    if (b.unitPrice < 0n) invalid.push({ bid: b, reason: 'negative_price' });
    else if (b.unitPrice > maxUnitPrice) invalid.push({ bid: b, reason: 'above_max_unit_price' });
    else if (b.etaMs > deadlineMs) invalid.push({ bid: b, reason: 'eta_exceeds_deadline' });
    else valid.push(b);
  }
  valid.sort((a, b) => {
    if (a.unitPrice !== b.unitPrice) return a.unitPrice < b.unitPrice ? -1 : 1;
    if (a.etaMs !== b.etaMs) return a.etaMs - b.etaMs;
    if (a.reputation !== b.reputation) return b.reputation - a.reputation;
    return a.receivedAt - b.receivedAt;
  });
  if (!valid.length) return { valid, invalid };
  const winner = valid[0];
  const second = valid[1];
  const clearingUnitPrice = second ? (second.unitPrice < maxUnitPrice ? second.unitPrice : maxUnitPrice) : winner.unitPrice;
  return { valid, invalid, winner, clearingUnitPrice };
}

export interface AuctionParams {
  jobType: JobType;
  model: string;
  units: number;
  currency: Currency;
  maxUnitPrice: bigint;
  deadlineMs: number;
  minTier?: Tier;
  persona?: string;
  agentId?: string;
  jobId?: string;
}
export type AuctionOutcome =
  | { kind: 'cleared'; auction: AuctionView; winner: LiveProvider; clearingUnitPrice: bigint; reservationKey: string }
  | { kind: 'no_capacity'; retryAfterMs: number }
  | { kind: 'no_acceptable_bid'; auction: AuctionView; bestBid?: BidView; suggestedMaxUnitPrice?: bigint };

type BidMsg = Extract<ProviderMessage, { type: 'bid' | 'pass' }>;

export class AuctionEngine {
  private active = new Map<string, (providerId: string, msg: BidMsg) => void>();
  openCount = 0;
  lastClearing: Partial<Record<JobType, bigint>> = {};

  constructor(private ctx: Ctx) {
    for (const t of ['embed', 'generate', 'stream'] as const) {
      const v = ctx.repo.lastClearing(t);
      if (v) this.lastClearing[t] = BigInt(v);
    }
  }

  onBid(providerId: string, msg: BidMsg): void {
    this.active.get(msg.auctionId)?.(providerId, msg);
  }

  async run(params: AuctionParams, onReservationExpired?: () => void): Promise<AuctionOutcome> {
    const { registry, repo, events, config } = this.ctx;
    const eligible = registry.eligible({ model: params.model, minTier: params.minTier, jobType: params.jobType });
    if (!eligible.length) return { kind: 'no_capacity', retryAfterMs: 2000 };

    const id = newId('a');
    const openedAt = now();
    const closeAt = openedAt + config.rfqWindowMs;
    const row: AuctionRow = {
      id,
      job_id: params.jobId ?? null,
      job_type: params.jobType,
      model: params.model,
      units: params.units,
      currency: params.currency,
      max_unit_price: params.maxUnitPrice.toString(),
      deadline_ms: params.deadlineMs,
      persona: params.persona ?? null,
      agent_id: params.agentId ?? null,
      opened_at: openedAt,
      closed_at: null,
      winner_provider_id: null,
      clearing_unit_price: null,
      status: 'open',
    };
    repo.insertAuction(row);
    const bidRows: BidRow[] = [];
    const bids: BidInput[] = [];
    events.emit({ type: 'auction.opened', auction: auctionView(row, [], registry.nameOf) });

    const pending = new Set(eligible.map((p) => p.id));
    this.openCount++;
    await new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, config.rfqWindowMs);
      this.active.set(id, (providerId, msg) => {
        if (!pending.has(providerId)) return;
        pending.delete(providerId);
        if (msg.type === 'bid') {
          const p = registry.get(providerId);
          const unitPrice = BigInt(msg.unitPrice);
          const bid: BidInput = { providerId, unitPrice, etaMs: msg.etaMs, reputation: p ? registry.reputation(p) : 0, receivedAt: now(), shade: msg.shade, surge: msg.surge };
          bids.push(bid);
          const valid = unitPrice <= params.maxUnitPrice && msg.etaMs <= params.deadlineMs;
          const reason = valid ? null : unitPrice > params.maxUnitPrice ? 'above_max_unit_price' : 'eta_exceeds_deadline';
          const br: BidRow = { id: newId('b'), auction_id: id, provider_id: providerId, unit_price: msg.unitPrice, eta_ms: msg.etaMs, shade: msg.shade, surge: msg.surge, received_at: bid.receivedAt, valid: valid ? 1 : 0, reason };
          bidRows.push(br);
          events.emit({ type: 'auction.bid', auctionId: id, bid: { providerId, providerName: registry.nameOf(providerId) ?? providerId, unitPrice: msg.unitPrice, etaMs: msg.etaMs, shade: msg.shade, surge: msg.surge, valid, reason: reason ?? undefined, receivedAt: bid.receivedAt } });
        }
        if (pending.size === 0) done();
      });
      const rfq = { type: 'rfq' as const, auctionId: id, jobType: params.jobType, model: params.model, units: params.units, currency: params.currency, maxUnitPrice: params.maxUnitPrice.toString(), deadlineMs: params.deadlineMs, closeAt };
      for (const p of eligible) registry.send(p.id, rfq);
    });
    this.active.delete(id);
    this.openCount--;

    for (const br of bidRows) repo.insertBid(br);
    // providers that vanished during the window cannot win
    const live = bids.filter((b) => registry.get(b.providerId)?.online);
    const result = clearAuction(live, params.maxUnitPrice, params.deadlineMs);
    const closedAt = now();

    if (!result.winner || !result.clearingUnitPrice) {
      const status = bids.length ? 'no_acceptable_bid' : 'no_bids';
      repo.updateAuction(id, { status, closed_at: closedAt });
      const view = auctionView({ ...row, status, closed_at: closedAt }, bidRows, registry.nameOf);
      const best = bids.length ? bids.reduce((a, b) => (b.unitPrice < a.unitPrice ? b : a)) : undefined;
      const bestBid = best ? view.bids.find((b) => b.providerId === best.providerId) : undefined;
      events.emit({ type: 'auction.failed', auction: view, reason: status });
      for (const b of bids) registry.send(b.providerId, { type: 'lose', auctionId: id });
      return { kind: 'no_acceptable_bid', auction: view, bestBid, suggestedMaxUnitPrice: best?.unitPrice };
    }

    const winner = registry.get(result.winner.providerId)!;
    const clearing = result.clearingUnitPrice;
    const reservationKey = `${id}`;
    const quoteExpiresAt = closedAt + config.quoteTtlMs;
    registry.reserve(winner, reservationKey, config.quoteTtlMs, onReservationExpired);
    winner.wins++;
    repo.updateAuction(id, { status: 'cleared', closed_at: closedAt, winner_provider_id: winner.id, clearing_unit_price: clearing.toString() });
    const view = auctionView({ ...row, status: 'cleared', closed_at: closedAt, winner_provider_id: winner.id, clearing_unit_price: clearing.toString() }, bidRows, registry.nameOf);
    events.emit({ type: 'auction.cleared', auction: view });
    registry.send(winner.id, { type: 'award', auctionId: id, clearingUnitPrice: clearing.toString(), quoteExpiresAt });
    for (const b of bids) if (b.providerId !== winner.id) registry.send(b.providerId, { type: 'lose', auctionId: id, clearingUnitPrice: clearing.toString() });

    this.lastClearing[params.jobType] = clearing;
    const supply = [...registry.providers.values()].reduce((n, p) => n + (p.online && p.status === 'verified' ? registry.freeSlots(p) : 0), 0);
    const tick = { job_type: params.jobType, currency: params.currency, unit_price: clearing.toString(), demand: this.openCount + 1, supply, ts: closedAt };
    repo.insertTick(tick);
    events.emit({ type: 'price.tick', tick: { jobType: params.jobType, currency: params.currency, unitPrice: clearing.toString(), ts: closedAt, demand: tick.demand, supply } });

    return { kind: 'cleared', auction: view, winner, clearingUnitPrice: clearing, reservationKey };
  }
}
