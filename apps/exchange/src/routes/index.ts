import type { Express } from 'express';
import type { Ctx } from '../context';
import { marketRoutes } from './market';
import { jobsRoutes } from './jobs';
import { agentRoutes } from './agents';
import { adminRoutes } from './admin';
import { rateLimit } from '../ratelimit';

export function mountRoutes(app: Express, ctx: Ctx): void {
  app.use('/v1', rateLimit({ windowMs: 10_000, max: Number(process.env.RATE_LIMIT_PER_10S ?? 150) }));
  app.use('/v1', marketRoutes(ctx));
  app.use('/v1', jobsRoutes(ctx));
  app.use('/v1', agentRoutes(ctx));
  app.use('/v1', adminRoutes(ctx));
}
