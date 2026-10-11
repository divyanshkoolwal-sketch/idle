import { Router } from 'express';
import type { Ctx } from '../context';
import { buildMarket, buildStats, recentAuctions } from '../snapshot';
import { jobView, paymentView } from '../views';

const lim = (q: unknown, dflt: number, max = 500) => {
  const n = Number(q);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
};

export function marketRoutes(ctx: Ctx): Router {
  const r = Router();
  r.get('/health', (_req, res) => {
    res.json({ ok: true, stats: buildStats(ctx), payments: ctx.config.payments, credentials: ctx.config.credentials, issuer: ctx.credentials.issuerAddress });
  });
  r.get('/market', (_req, res) => res.json(buildMarket(ctx)));
  r.get('/providers', (_req, res) => res.json(ctx.registry.views()));
  r.get('/providers/:id', (req, res) => {
    const p = ctx.registry.get(req.params.id);
    if (!p) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    res.json(ctx.registry.view(p));
  });
  r.get('/auctions', (req, res) => res.json(recentAuctions(ctx, lim(req.query.limit, 50))));
  r.get('/payments', (req, res) => res.json(ctx.repo.listPayments(lim(req.query.limit, 50)).map((p) => paymentView(p, ctx.registry.nameOf))));
  r.get('/jobs', (req, res) => res.json(ctx.repo.listJobs(lim(req.query.limit, 50)).map((j) => jobView(j, ctx.registry.nameOf))));
  return r;
}
