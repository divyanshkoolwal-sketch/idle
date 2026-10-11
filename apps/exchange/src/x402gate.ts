/**
 * x402 gate for POST /v1/jobs (PAYMENTS=on).
 * quote → 402 (PAYMENT-REQUIRED header + quote JSON) → paid retry → facilitator verify → run the job →
 * spot check → settle ONLY if the work passed → 200 with result + receipt. Failed work is never paid.
 */
import type { Request, Response } from 'express';
import { createAusdGate } from '@idle/pay-evm';
import type { Ctx } from './context';
import type { QuoteState } from './market';
import type { PaymentRow } from './db/repo';
import { paymentView } from './views';
import { newId, now } from './ids';

let instance: ReturnType<typeof createAusdGate> | null = null;
/** (payer:nonce) → validBefore (unix s). A verified authorization may only be used for one job. */
const usedNonces = new Map<string, number>();
function nonceUsed(key: string, validBefore: number): boolean {
  const nowS = Math.floor(Date.now() / 1000);
  for (const [k, exp] of usedNonces) if (exp < nowS) usedNonces.delete(k);
  if (usedNonces.has(key)) return true;
  usedNonces.set(key, validBefore);
  return false;
}
function ausdGate() {
  return (instance ??= createAusdGate({
    routePattern: 'POST /v1/jobs',
    facilitatorUrl: process.env.FACILITATOR_URL,
    maxTimeoutSeconds: 120,
    description: 'Idle compute job (embed / generate), paid in AUSD to the auction winner',
  }));
}

export async function gate(req: Request, res: Response, state: QuoteState, ctx: Ctx): Promise<void> {
  const { quote } = state;
  const { repo, events, registry, market } = ctx;

  let g;
  try {
    g = await ausdGate().check(req, res, { payTo: quote.payTo, amount: BigInt(quote.amount), body402: { error: 'PAYMENT_REQUIRED', quote } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[x402] gate error:', msg);
    res.status(503).json({ error: 'FACILITATOR_UNAVAILABLE', message: msg, retryAfterMs: 2000 });
    return;
  }
  if (g.kind === 'responded') return; // 402 sent (first call) or a payment error

  // The authorization must outlive the job + settlement, and may be used once.
  const auth = g.authorization;
  if (auth) {
    const validBefore = Number(auth.validBefore);
    const needUntil = Math.floor(Date.now() / 1000) + Math.ceil(state.deadlineMs / 1000) + 45;
    if (!Number.isFinite(validBefore) || validBefore < needUntil) {
      await g.abandon('authorization_too_short');
      res.status(400).json({ error: 'AUTHORIZATION_TOO_SHORT', message: `validBefore must be ≥ now + deadline + 45 s (need ${needUntil}, got ${validBefore})`, charged: false });
      return;
    }
    if (nonceUsed(`${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`, validBefore)) {
      await g.abandon('nonce_reused');
      res.status(409).json({ error: 'AUTHORIZATION_REUSED', message: 'this signed authorization was already used for a job', charged: false });
      return;
    }
  }

  // Signed authorization verified by our facilitator. Record it; nothing has moved on-chain yet.
  const payment: PaymentRow = {
    id: newId('pay'),
    job_id: quote.jobId,
    auction_id: quote.auctionId,
    rail: 'x402',
    currency: 'AUSD',
    amount_atomic: quote.amount,
    payer: g.payer ?? 'unknown',
    payee: quote.payTo,
    payee_provider_id: quote.providerId,
    tx_hash: null,
    status: 'verified',
    reason: null,
    created_at: now(),
  };
  repo.insertPayment(payment);
  events.emit({ type: 'payment.verified', payment: paymentView(payment, registry.nameOf) });

  let run;
  try {
    run = await market.runJob(state);
  } catch (e) {
    await g.abandon('exception');
    const reason = `exception: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[x402] runJob threw for ${quote.jobId}: ${reason}`);
    repo.updatePayment(payment.id, { status: 'not_settled', reason });
    events.emit({ type: 'payment.not_settled', payment: paymentView({ ...payment, status: 'not_settled', reason }, registry.nameOf) });
    res.status(502).json({ error: 'PROVIDER_ERROR', charged: false, jobId: quote.jobId, providerId: quote.providerId });
    return;
  }
  if (!run.ok) {
    await g.abandon(run.code);
    const reason = run.code === 'PROVIDER_FAILED_VERIFICATION' ? `spot check failed (cosine ${run.cosine?.toFixed(4) ?? '?'})` : run.error ?? run.code;
    const failed: PaymentRow = { ...payment, status: 'not_settled', reason };
    repo.updatePayment(payment.id, { status: 'not_settled', reason });
    events.emit({ type: 'payment.not_settled', payment: paymentView(failed, registry.nameOf) });
    if (run.code === 'PROVIDER_FAILED_VERIFICATION') {
      res.status(502).json({ error: 'PROVIDER_FAILED_VERIFICATION', charged: false, jobId: run.jobId, providerId: run.providerId, cosine: run.cosine });
    } else {
      res.status(502).json({ error: run.code, charged: false, jobId: run.jobId, providerId: run.providerId, message: run.error });
    }
    return;
  }

  let settled: Awaited<ReturnType<typeof g.settle>>;
  try {
    settled = await g.settle();
  } catch (e) {
    settled = { success: false, reason: 'settle_exception', message: e instanceof Error ? e.message : String(e) };
  }
  if (!settled.success) {
    const reason = `${settled.reason}${settled.message ? `: ${settled.message}` : ''}`;
    console.error(`[x402] settlement failed for job ${quote.jobId}: ${reason}`);
    const failed: PaymentRow = { ...payment, status: 'not_settled', reason };
    repo.updatePayment(payment.id, { status: 'not_settled', reason });
    events.emit({ type: 'payment.not_settled', payment: paymentView(failed, registry.nameOf) });
    // No settlement → no result. The buyer was not charged and may resubmit.
    res.status(502).json({ error: 'SETTLEMENT_FAILED', charged: false, jobId: quote.jobId, providerId: quote.providerId, reason: settled.reason });
    return;
  }

  const settledRow: PaymentRow = { ...payment, status: 'settled', tx_hash: settled.txHash };
  repo.updatePayment(payment.id, { status: 'settled', tx_hash: settled.txHash });
  const p = registry.get(quote.providerId);
  if (p) {
    p.earningsAusd += BigInt(quote.amount);
    repo.updateProvider(p.id, { earnings_ausd: p.earningsAusd.toString() });
  }
  events.emit({ type: 'payment.settled', payment: paymentView(settledRow, registry.nameOf) });
  console.log(`[x402] settled ${quote.amount} AUSD-atomic → ${quote.providerName} ${settled.explorerUrl}`);

  res.json({
    ...run.result,
    receipt: { txHash: settled.txHash, explorerUrl: settled.explorerUrl, amount: quote.amount, currency: 'AUSD', payee: quote.payTo, unitPrice: quote.unitPrice },
  });
}
