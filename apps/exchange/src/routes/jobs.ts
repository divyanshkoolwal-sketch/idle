import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { CreateJobRequest, CreateStreamRequest } from '@idle/shared';
import type { Ctx } from '../context';
import { gate } from '../x402gate';

export function jobsRoutes(ctx: Ctx): Router {
  const r = Router();

  r.post('/jobs', async (req, res) => {
    const parsed = CreateJobRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'BAD_REQUEST', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      return;
    }
    const idem = req.header('Idempotency-Key') ?? randomUUID();
    res.setHeader('Idempotency-Key', idem);
    let state = ctx.market.quoteByIdem(idem);
    if (!state) {
      const out = await ctx.market.quoteJob(parsed.data, { idemKey: idem });
      if (out.kind === 'bad_request') {
        res.status(400).json({ error: 'BAD_REQUEST', details: [out.message] });
        return;
      }
      if (out.kind === 'no_capacity') {
        res.setHeader('Retry-After', String(Math.ceil(out.retryAfterMs / 1000)));
        res.status(503).json({ error: 'NO_CAPACITY', retryAfterMs: out.retryAfterMs });
        return;
      }
      if (out.kind === 'no_acceptable_bid') {
        res.status(409).json({ error: 'NO_ACCEPTABLE_BID', auctionId: out.auctionId, bestBid: out.bestBid, suggestedMaxUnitPrice: out.suggestedMaxUnitPrice?.toString() });
        return;
      }
      state = out.state;
    }
    if (ctx.config.payments === 'on') return gate(req, res, state, ctx);

    const run = await ctx.market.runJob(state);
    if (!run.ok) {
      if (run.code === 'PROVIDER_FAILED_VERIFICATION') {
        res.status(502).json({ error: 'PROVIDER_FAILED_VERIFICATION', charged: false, jobId: run.jobId, providerId: run.providerId, cosine: run.cosine });
      } else {
        res.status(502).json({ error: run.code, charged: false, jobId: run.jobId, providerId: run.providerId, message: run.error });
      }
      return;
    }
    res.json(run.result);
  });

  r.post('/streams', async (req, res) => {
    const parsed = CreateStreamRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'BAD_REQUEST', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      return;
    }
    const out = await ctx.streams.quote(parsed.data);
    if (out.kind === 'no_capacity') {
      res.setHeader('Retry-After', String(Math.ceil(out.retryAfterMs / 1000)));
      res.status(503).json({ error: 'NO_CAPACITY', retryAfterMs: out.retryAfterMs });
      return;
    }
    if (out.kind === 'no_acceptable_bid') {
      res.status(409).json({ error: 'NO_ACCEPTABLE_BID', auctionId: out.auctionId, bestBid: out.bestBid, suggestedMaxUnitPrice: out.suggestedMaxUnitPrice?.toString() });
      return;
    }
    res.json(out.quote);
  });

  return r;
}
