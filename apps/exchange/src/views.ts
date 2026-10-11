import type { AuctionView, BidView, JobView, PaymentView, AgentLog, PriceTick, Currency, JobType } from '@idle/shared';
import { basescanTx, xrplTx } from '@idle/shared';
import type { AuctionRow, BidRow, JobRow, PaymentRow, AgentLogRow, TickRow } from './db/repo';

export type NameLookup = (providerId: string | null | undefined) => string | undefined;

export function bidView(b: BidRow, name: NameLookup): BidView {
  return {
    providerId: b.provider_id,
    providerName: name(b.provider_id) ?? b.provider_id,
    unitPrice: b.unit_price,
    etaMs: b.eta_ms,
    shade: b.shade ?? undefined,
    surge: b.surge ?? undefined,
    valid: b.valid === 1,
    reason: b.reason ?? undefined,
    receivedAt: b.received_at,
  };
}

export function auctionView(a: AuctionRow, bids: BidRow[], name: NameLookup): AuctionView {
  return {
    id: a.id,
    jobId: a.job_id ?? undefined,
    jobType: a.job_type as JobType,
    model: a.model,
    units: a.units,
    currency: a.currency as Currency,
    maxUnitPrice: a.max_unit_price,
    deadlineMs: a.deadline_ms,
    persona: a.persona ?? undefined,
    agentId: a.agent_id ?? undefined,
    openedAt: a.opened_at,
    closedAt: a.closed_at ?? undefined,
    status: a.status as AuctionView['status'],
    winnerProviderId: a.winner_provider_id ?? undefined,
    winnerName: name(a.winner_provider_id),
    clearingUnitPrice: a.clearing_unit_price ?? undefined,
    bids: bids.map((b) => bidView(b, name)),
  };
}

export function jobView(j: JobRow, name: NameLookup): JobView {
  return {
    id: j.id,
    auctionId: j.auction_id ?? '',
    agentId: j.buyer_id ?? undefined,
    persona: j.persona ?? undefined,
    jobType: j.job_type as JobType,
    model: j.model,
    units: j.units,
    rail: j.rail as JobView['rail'],
    status: j.status as JobView['status'],
    providerId: j.provider_id ?? undefined,
    providerName: name(j.provider_id),
    unitPrice: j.unit_price,
    amount: j.amount,
    currency: j.currency as Currency,
    latencyMs: j.latency_ms ?? undefined,
    verification: j.verify_json ? (JSON.parse(j.verify_json) as JobView['verification']) : undefined,
    createdAt: j.created_at,
  };
}

export function paymentView(p: PaymentRow, name: NameLookup): PaymentView {
  const explorerUrl = p.tx_hash ? (p.rail === 'x402' ? basescanTx(p.tx_hash) : xrplTx(p.tx_hash)) : undefined;
  return {
    id: p.id,
    jobId: p.job_id,
    auctionId: p.auction_id ?? undefined,
    rail: p.rail as PaymentView['rail'],
    currency: p.currency as Currency,
    amount: p.amount_atomic,
    payer: p.payer,
    payee: p.payee,
    payeeName: name(p.payee_provider_id),
    txHash: p.tx_hash ?? undefined,
    explorerUrl,
    status: p.status as PaymentView['status'],
    reason: p.reason ?? undefined,
    createdAt: p.created_at,
  };
}

export function logView(l: AgentLogRow): AgentLog {
  return {
    agentId: l.agent_id,
    persona: l.persona,
    kind: l.kind as AgentLog['kind'],
    text: l.text,
    ts: l.created_at,
    meta: l.meta_json ? (JSON.parse(l.meta_json) as Record<string, unknown>) : undefined,
  };
}

export function tickView(t: TickRow): PriceTick {
  return { jobType: t.job_type as JobType, currency: t.currency as Currency, unitPrice: t.unit_price, ts: t.ts, demand: t.demand ?? undefined, supply: t.supply ?? undefined };
}
