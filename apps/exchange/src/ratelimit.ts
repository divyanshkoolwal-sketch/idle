import type { Request, Response, NextFunction } from 'express';

/** Tiny per-IP sliding-window limiter for unauthenticated POSTs (quotes, streams, agent logs). */
export function rateLimit(opts: { windowMs: number; max: number; methods?: string[] }) {
  const hits = new Map<string, number[]>();
  const methods = new Set(opts.methods ?? ['POST']);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!methods.has(req.method)) return next();
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const nowMs = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => nowMs - t < opts.windowMs);
    if (arr.length >= opts.max) {
      const retryAfterMs = opts.windowMs - (nowMs - arr[0]);
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      res.status(429).json({ error: 'RATE_LIMITED', retryAfterMs });
      return;
    }
    arr.push(nowMs);
    hits.set(key, arr);
    if (hits.size > 10_000) hits.clear();
    next();
  };
}
