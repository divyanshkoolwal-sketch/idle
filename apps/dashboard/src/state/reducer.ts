import type { DashboardEvent, ProviderView, PriceTick, PaymentView, JobView } from '@shared/protocol';
import { ausd, xrp } from '@/lib/format';
import { basescanTx, xrplTx } from '@/lib/links';
import { initialState, type FeedItem, type MarketState } from './types';

const MAX_AUCTIONS = 50;
const MAX_FEED = 200;
const MAX_LOGS = 400;
const PRICE_WINDOW_MS = 10 * 60_000;

const add = (a: string, b: string) => (BigInt(a || '0') + BigInt(b || '0')).toString();

function pushFeed(state: MarketState, item: FeedItem): FeedItem[] {
  const without = state.feed.filter((f) => f.id !== item.id);
  return [item, ...without].slice(0, MAX_FEED);
}

function pushTick(prices: PriceTick[], tick: PriceTick, now: number): PriceTick[] {
  if (prices.some((p) => p.jobType === tick.jobType && p.ts === tick.ts)) return prices;
  const next = [...prices, tick].sort((a, b) => a.ts - b.ts);
  const cutoff = now - PRICE_WINDOW_MS;
  return next.filter((p) => p.ts >= cutoff);
}

function providerByPayee(state: MarketState, p: PaymentView): ProviderView | undefined {
  const byAddr = Object.values(state.providers).find((x) => x.evmAddress.toLowerCase() === p.payee.toLowerCase() || x.xrplAddress === p.payee);
  if (byAddr) return byAddr;
  return p.payeeName ? Object.values(state.providers).find((x) => x.name === p.payeeName) : undefined;
}

function paymentsToFeed(payments: PaymentView[]): FeedItem[] {
  return payments
    .filter((p) => p.status !== 'verified')
    .map((p) => paymentItem(p))
    .sort((a, b) => b.ts - a.ts);
}

function jobDetail(job?: JobView): string | undefined {
  if (!job) return undefined;
  const unit = job.jobType === 'embed' ? 'text' : 'token';
  const sym = job.currency === 'XRP' ? 'drops' : 'µAUSD';
  return `${job.jobType} · ${job.units} ${unit}s at ${Number(job.unitPrice).toLocaleString('en-US')} ${sym}/${unit}${job.persona ? ` · ${job.persona}` : ''}`;
}

function paymentItem(p: PaymentView, job?: JobView): FeedItem {
  const amount = p.currency === 'AUSD' ? `${ausd(p.amount)} AUSD` : `${xrp(p.amount)} XRP`;
  if (p.status === 'settled') {
    return {
      id: `pay:${p.id}`,
      ts: p.createdAt,
      tone: 'live',
      kind: 'settled',
      title: `${amount} → ${p.payeeName ?? p.payee}`,
      detail: jobDetail(job) ?? (p.rail === 'x402' ? 'x402 settlement, paid after verification' : 'XRPL channel claim'),
      href: p.explorerUrl ?? (p.txHash ? (p.rail === 'x402' ? basescanTx(p.txHash) : xrplTx(p.txHash)) : undefined),
      linkLabel: p.rail === 'x402' ? 'Basescan' : 'XRPL',
    };
  }
  return {
    id: `pay:${p.id}`,
    ts: p.createdAt,
    tone: 'bad',
    kind: 'not_settled',
    title: `${amount} withheld from ${p.payeeName ?? p.payee}`,
    detail: [jobDetail(job), p.reason ?? 'not settled'].filter(Boolean).join(' · '),
  };
}

export function reduce(state: MarketState, ev: DashboardEvent): MarketState {
  const now = Math.max(state.now, ev.ts);
  const base = { ...state, now, eventCount: state.eventCount + 1 };
  switch (ev.type) {
    case 'snapshot': {
      const providers: Record<string, ProviderView> = {};
      for (const p of ev.providers) providers[p.id] = p;
      const jobs: MarketState['jobs'] = {};
      for (const j of ev.jobs) jobs[j.id] = j;
      const auctions = [...ev.auctions].sort((a, b) => b.openedAt - a.openedAt).slice(0, MAX_AUCTIONS);
      return {
        ...initialState,
        now: ev.ts,
        eventCount: base.eventCount,
        providers,
        auctions,
        jobs,
        feed: paymentsToFeed(ev.payments),
        prices: [...ev.prices].sort((a, b) => a.ts - b.ts).filter((p) => p.ts >= ev.ts - PRICE_WINDOW_MS),
        stats: ev.stats,
        logs: ev.logs.slice(-MAX_LOGS),
        issuer: ev.issuer,
        openAuctions: auctions.filter((a) => a.status === 'open').length,
      };
    }
    case 'provider.online': {
      const prev = state.providers[ev.provider.id];
      return { ...base, providers: { ...state.providers, [ev.provider.id]: { ...prev, ...ev.provider, online: true } } };
    }
    case 'provider.offline': {
      const p = state.providers[ev.providerId];
      if (!p) return base;
      return {
        ...base,
        providers: { ...state.providers, [p.id]: { ...p, online: false, busySlots: 0, status: p.status === 'suspended' ? 'suspended' : 'offline', lastSeen: ev.ts } },
      };
    }
    case 'provider.util': {
      const p = state.providers[ev.providerId];
      if (!p) return base;
      return {
        ...base,
        providers: {
          ...state.providers,
          [p.id]: {
            ...p,
            busySlots: ev.busySlots,
            slots: ev.slots,
            queueDepth: ev.queueDepth,
            shade: ev.shade,
            surge: ev.surge,
            asks: ev.asks,
            draining: ev.draining,
            cheat: ev.cheat,
            online: true,
            lastSeen: ev.ts,
            status: p.status === 'offline' ? (p.tier ? 'verified' : 'pending') : p.status,
          },
        },
      };
    }
    case 'provider.verified': {
      const p = state.providers[ev.providerId];
      if (!p) return base;
      return {
        ...base,
        providers: {
          ...state.providers,
          [p.id]: { ...p, tier: ev.tier, status: 'verified', credential: { ...p.credential, type: ev.credential.type, issueTx: ev.credential.issueTx, acceptTx: ev.credential.acceptTx, status: 'accepted' } },
        },
      };
    }
    case 'provider.strike': {
      const p = state.providers[ev.providerId];
      if (!p) return base;
      return { ...base, providers: { ...state.providers, [p.id]: { ...p, strikes: ev.strikes } } };
    }
    case 'provider.suspended': {
      const p = state.providers[ev.providerId];
      if (!p) return base;
      return {
        ...base,
        providers: {
          ...state.providers,
          [p.id]: { ...p, status: 'suspended', strikes: ev.strikes, busySlots: 0, credential: { ...(p.credential ?? { type: '', status: '' }), deleteTx: ev.deleteTx ?? p.credential?.deleteTx, status: 'revoked' } },
        },
      };
    }
    case 'auction.opened': {
      const auctions = [ev.auction, ...state.auctions.filter((a) => a.id !== ev.auction.id)].slice(0, MAX_AUCTIONS);
      return { ...base, auctions, openAuctions: auctions.filter((a) => a.status === 'open').length };
    }
    case 'auction.bid': {
      const auctions = state.auctions.map((a) =>
        a.id === ev.auctionId ? { ...a, bids: [...a.bids.filter((b) => b.providerId !== ev.bid.providerId), ev.bid] } : a,
      );
      return { ...base, auctions };
    }
    case 'auction.cleared':
    case 'auction.failed': {
      const exists = state.auctions.some((a) => a.id === ev.auction.id);
      const auctions = exists ? state.auctions.map((a) => (a.id === ev.auction.id ? ev.auction : a)) : [ev.auction, ...state.auctions].slice(0, MAX_AUCTIONS);
      let next: MarketState = { ...base, auctions, openAuctions: auctions.filter((a) => a.status === 'open').length };
      if (ev.type === 'auction.cleared' && ev.auction.winnerProviderId && ev.auction.clearingUnitPrice) {
        next = {
          ...next,
          wins: { ...state.wins, [ev.auction.winnerProviderId]: ev.ts },
          stats: { ...state.stats, jobsCleared: state.stats.jobsCleared + 1, clearing: { ...state.stats.clearing, [ev.auction.jobType]: ev.auction.clearingUnitPrice } },
          prices: pushTick(state.prices, { jobType: ev.auction.jobType, currency: ev.auction.currency, unitPrice: ev.auction.clearingUnitPrice, ts: ev.ts }, now),
        };
      }
      return next;
    }
    case 'job.dispatched':
    case 'job.completed': {
      const jobs = { ...state.jobs, [ev.job.id]: ev.job };
      let providers = state.providers;
      if (ev.type === 'job.completed' && ev.job.providerId && state.providers[ev.job.providerId]) {
        const p = state.providers[ev.job.providerId];
        providers = { ...providers, [p.id]: { ...p, jobsDone: p.jobsDone + 1 } };
      }
      return { ...base, jobs, providers };
    }
    case 'job.failed': {
      return {
        ...base,
        jobs: { ...state.jobs, [ev.job.id]: ev.job },
        feed: pushFeed(state, { id: `jobfail:${ev.job.id}`, ts: ev.ts, tone: 'bad', kind: 'job.failed', title: `Job failed on ${ev.job.providerName ?? ev.job.providerId ?? 'provider'}`, detail: ev.error }),
      };
    }
    case 'verify.passed': {
      const j = state.jobs[ev.jobId];
      return j ? { ...base, jobs: { ...state.jobs, [j.id]: { ...j, verification: { sampled: true, passed: true, cosine: ev.cosine } } } } : base;
    }
    case 'verify.failed': {
      const p = state.providers[ev.providerId];
      const j = state.jobs[ev.jobId];
      return {
        ...base,
        providers: p ? { ...state.providers, [p.id]: { ...p, strikes: ev.strikes } } : state.providers,
        jobs: j ? { ...state.jobs, [j.id]: { ...j, verification: { sampled: true, passed: false, cosine: ev.cosine } } } : state.jobs,
        feed: pushFeed(state, {
          id: `verify:${ev.jobId}`,
          ts: ev.ts,
          tone: 'bad',
          kind: 'verify.failed',
          title: `Spot check failed — ${p?.name ?? ev.providerId}`,
          detail: `cosine ${ev.cosine.toFixed(3)} against the reference · strike ${ev.strikes}`,
        }),
      };
    }
    case 'payment.verified':
      return base;
    case 'payment.settled': {
      const p = providerByPayee(state, ev.payment);
      const providers = p
        ? { ...state.providers, [p.id]: { ...p, earnings: ev.payment.currency === 'AUSD' ? { ...p.earnings, ausd: add(p.earnings.ausd, ev.payment.amount) } : { ...p.earnings, drops: add(p.earnings.drops, ev.payment.amount) } } }
        : state.providers;
      const item = paymentItem({ ...ev.payment, payeeName: ev.payment.payeeName ?? p?.name }, state.jobs[ev.payment.jobId]);
      return {
        ...base,
        providers,
        feed: pushFeed(state, { ...item, ts: ev.ts }),
        stats: ev.payment.currency === 'AUSD' ? { ...state.stats, ausdSettled: add(state.stats.ausdSettled, ev.payment.amount) } : state.stats,
      };
    }
    case 'payment.not_settled': {
      const p = providerByPayee(state, ev.payment);
      const item = paymentItem({ ...ev.payment, status: 'not_settled', payeeName: ev.payment.payeeName ?? p?.name }, state.jobs[ev.payment.jobId]);
      return { ...base, feed: pushFeed(state, { ...item, ts: ev.ts }) };
    }
    case 'credential.issued':
      return {
        ...base,
        feed: pushFeed(state, { id: `cred.issued:${ev.txHash}`, ts: ev.ts, tone: 'ink', kind: 'credential', title: `Credential issued — Tier ${ev.tier} for ${ev.providerName}`, detail: 'CredentialCreate by the exchange', href: xrplTx(ev.txHash), linkLabel: 'XRPL' }),
      };
    case 'credential.accepted':
      return {
        ...base,
        feed: pushFeed(state, { id: `cred.accepted:${ev.txHash}`, ts: ev.ts, tone: 'ink', kind: 'credential', title: `Credential accepted — ${ev.providerName}`, detail: 'CredentialAccept by the data center', href: xrplTx(ev.txHash), linkLabel: 'XRPL' }),
      };
    case 'credential.revoked': {
      const p = state.providers[ev.providerId];
      return {
        ...base,
        providers: p ? { ...state.providers, [p.id]: { ...p, status: 'suspended', strikes: ev.strikes, busySlots: 0, credential: { ...(p.credential ?? { type: '', status: '' }), deleteTx: ev.txHash, status: 'revoked' } } } : state.providers,
        feed: pushFeed(state, { id: `cred.revoked:${ev.txHash}`, ts: ev.ts, tone: 'bad', kind: 'credential', title: `Credential revoked — ${ev.providerName}`, detail: `CredentialDelete after ${ev.strikes} strikes`, href: xrplTx(ev.txHash), linkLabel: 'XRPL' }),
      };
    }
    case 'paychan.opened': {
      const p = state.providers[ev.providerId];
      return {
        ...base,
        streams: { ...state.streams, [ev.streamId]: { streamId: ev.streamId, providerId: ev.providerId, channelId: ev.channelId, buyer: ev.buyer, dropsPerToken: ev.dropsPerToken, tokens: 0, claimedDrops: '0', openedAt: ev.ts } },
        feed: pushFeed(state, { id: `chan:${ev.streamId}`, ts: ev.ts, tone: 'ink', kind: 'paychan', title: `Channel open → ${p?.name ?? ev.providerId}`, detail: `${Number(ev.dropsPerToken).toLocaleString()} drops per token, pay as you stream`, href: `https://testnet.xrpl.org/accounts/${ev.buyer}`, linkLabel: 'XRPL' }),
      };
    }
    case 'stream.token': {
      const s = state.streams[ev.streamId];
      return s ? { ...base, streams: { ...state.streams, [s.streamId]: { ...s, tokens: Math.max(s.tokens, ev.index + 1) } } } : base;
    }
    case 'paychan.claim': {
      const s = state.streams[ev.streamId];
      const p = state.providers[ev.providerId];
      return {
        ...base,
        streams: s ? { ...state.streams, [s.streamId]: { ...s, tokens: Math.max(s.tokens, ev.tokens), claimedDrops: ev.drops } } : state.streams,
        feed: pushFeed(state, { id: `claim:${ev.streamId}`, ts: ev.ts, tone: 'ink', kind: 'paychan.claim', title: `Streaming — ${ev.tokens} tokens signed for`, detail: `${Number(ev.drops).toLocaleString()} drops authorised off-ledger to ${p?.name ?? ev.providerId}` }),
      };
    }
    case 'paychan.claimed': {
      const s = state.streams[ev.streamId];
      const p = state.providers[ev.providerId];
      return {
        ...base,
        streams: s ? { ...state.streams, [s.streamId]: { ...s, settledTx: ev.txHash, tokens: ev.tokens, claimedDrops: ev.drops } } : state.streams,
        providers: p ? { ...state.providers, [p.id]: { ...p, earnings: { ...p.earnings, drops: add(p.earnings.drops, ev.drops) } } } : state.providers,
        stats: { ...state.stats, dropsStreamed: add(state.stats.dropsStreamed, ev.drops) },
        feed: pushFeed(state, { id: `claimed:${ev.txHash}`, ts: ev.ts, tone: 'live', kind: 'paychan.claimed', title: `${xrp(ev.drops)} XRP → ${p?.name ?? ev.providerId}`, detail: `channel claim settled for exactly ${ev.tokens} delivered tokens`, href: xrplTx(ev.txHash), linkLabel: 'XRPL' }),
      };
    }
    case 'price.tick':
      return { ...base, prices: pushTick(state.prices, ev.tick, now), stats: { ...state.stats, clearing: { ...state.stats.clearing, [ev.tick.jobType]: ev.tick.unitPrice } } };
    case 'stats':
      return { ...base, stats: ev.stats };
    case 'agent.log':
      return { ...base, logs: [...state.logs, ev.log].slice(-MAX_LOGS) };
    default:
      return base;
  }
}
