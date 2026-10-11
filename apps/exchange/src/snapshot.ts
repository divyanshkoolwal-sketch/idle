import type { MarketStats, MarketSnapshot } from '@idle/shared';
import type { Ctx } from './context';
import type { SnapshotInput } from './events';
import { auctionView, jobView, logView, paymentView, tickView } from './views';

export function buildStats(ctx: Ctx): MarketStats {
  const { registry, repo, auctions } = ctx;
  let online = 0;
  let verified = 0;
  let slotsTotal = 0;
  let slotsBusy = 0;
  for (const p of registry.providers.values()) {
    if (!p.online) continue;
    online++;
    if (p.status === 'verified') {
      verified++;
      slotsTotal += p.slots;
      slotsBusy += p.slots - registry.freeSlots(p);
    }
  }
  return {
    jobsCleared: repo.countJobsDone(),
    ausdSettled: repo.sumSettled('AUSD').toString(),
    dropsStreamed: repo.sumSettled('XRP').toString(),
    providersOnline: online,
    providersVerified: verified,
    slotsTotal,
    slotsBusy,
    clearing: {
      embed: auctions.lastClearing.embed?.toString(),
      generate: auctions.lastClearing.generate?.toString(),
      stream: auctions.lastClearing.stream?.toString(),
    },
  };
}

export function recentAuctions(ctx: Ctx, limit: number) {
  const rows = ctx.repo.listAuctions(limit);
  const bids = ctx.repo.listBidsForAuctions(rows.map((r) => r.id));
  return rows.map((r) => auctionView(r, bids.filter((b) => b.auction_id === r.id), ctx.registry.nameOf));
}

export function buildSnapshot(ctx: Ctx): SnapshotInput {
  const { registry, repo, credentials } = ctx;
  return {
    providers: registry.views(),
    auctions: recentAuctions(ctx, 30),
    payments: repo.listPayments(50).map((p) => paymentView(p, registry.nameOf)),
    jobs: repo.listJobs(50).map((j) => jobView(j, registry.nameOf)),
    stats: buildStats(ctx),
    prices: repo.listTicks(Date.now() - 10 * 60_000).map(tickView),
    logs: repo.listLogs(100).map(logView),
    issuer: credentials.issuerAddress,
  };
}

export function buildMarket(ctx: Ctx): MarketSnapshot {
  const { registry, credentials } = ctx;
  const depth = { embed: [] as string[], generate: [] as string[], stream: [] as string[] };
  for (const p of registry.providers.values()) {
    if (!p.online || p.status !== 'verified' || p.draining || registry.freeSlots(p) <= 0) continue;
    for (let i = 0; i < registry.freeSlots(p); i++) {
      depth.embed.push(p.asks.embed);
      depth.generate.push(p.asks.generate);
      depth.stream.push(p.asks.stream);
    }
  }
  const byBig = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  depth.embed.sort(byBig);
  depth.generate.sort(byBig);
  depth.stream.sort(byBig);
  return {
    providers: registry.views(),
    stats: buildStats(ctx),
    recentClearing: ctx.repo.listTicks(Date.now() - 10 * 60_000).map(tickView),
    depth,
    issuer: credentials.issuerAddress,
  };
}
