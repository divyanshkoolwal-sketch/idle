import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { AdminBurst, AdminProviderToggle } from '@idle/shared';
import type { Ctx } from '../context';
import { sentences } from '../corpus';

export function adminRoutes(ctx: Ctx): Router {
  const r = Router();
  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (!ctx.config.adminToken) {
      res.status(503).json({ error: 'ADMIN_DISABLED', message: 'ADMIN_TOKEN not set' });
      return;
    }
    const h = req.header('authorization') ?? '';
    const want = Buffer.from(`Bearer ${ctx.config.adminToken}`);
    const got = Buffer.from(h);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }
    next();
  };

  r.post('/admin/burst', auth, (req, res) => {
    const parsed = AdminBurst.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'BAD_REQUEST' });
      return;
    }
    const { jobs, jobType } = parsed.data;
    let started = 0;
    const fire = async (i: number) => {
      await new Promise((r) => setTimeout(r, i * 150));
      const texts = sentences(8 + Math.floor(Math.random() * 24), Date.now() + i);
      const maxUnitPrice = (jobType === 'embed' ? 12 + Math.floor(Math.random() * 30) : 20 + Math.floor(Math.random() * 40)).toString();
      const input = jobType === 'embed' ? { texts } : { prompt: texts.slice(0, 2).join(' '), maxTokens: 48 };
      const out = await ctx.market.quoteJob({ jobType, input, maxUnitPrice, deadlineMs: 15_000, persona: 'burst', agentId: 'admin-burst' });
      if (out.kind === 'quote') {
        started++;
        await ctx.market.runJob(out.state).catch((e) => console.error('[admin] burst job failed', e));
      }
    };
    void Promise.all(Array.from({ length: jobs }, (_, i) => fire(i)));
    res.status(202).json({ accepted: jobs, note: 'jobs run through quote+run internally (unpaid)', startedSoFar: started });
  });

  const toggle = (kind: 'cheat' | 'drain') => (req: Request, res: Response) => {
    const parsed = AdminProviderToggle.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'BAD_REQUEST' });
      return;
    }
    const ok = ctx.registry.forwardAdmin(parsed.data.providerId, kind, parsed.data.on);
    if (!ok) {
      res.status(404).json({ error: 'PROVIDER_NOT_CONNECTED' });
      return;
    }
    res.json({ ok: true, providerId: parsed.data.providerId, [kind]: parsed.data.on });
  };
  r.post('/admin/cheat', auth, toggle('cheat'));
  r.post('/admin/drain', auth, toggle('drain'));
  return r;
}
