import type { Request, Response } from 'express';
import type { Ctx } from './context';
import type { QuoteState } from './market';

/**
 * P2 hook: with PAYMENTS=on the job route hands the quote here. The real gate (x402 402 → verify →
 * run → settle-after-verify) lands in Phase 2; until then it refuses loudly.
 */
export async function gate(_req: Request, res: Response, state: QuoteState, _ctx: Ctx): Promise<void> {
  res.status(501).json({ error: 'PAYMENTS_NOT_WIRED', message: 'x402 gate not implemented yet; run the exchange with PAYMENTS=off', quote: state.quote });
}
