/**
 * Dynamic-price x402 gate for an Express route: price and payTo come from a per-request quote,
 * the 402 carries the quote in its JSON body (plus the standard PAYMENT-REQUIRED header),
 * and settlement is deferred until the caller decides the work passed verification.
 */
import type { Request, Response } from 'express';
import type { SettleResponse } from '@x402/core/types';
import { createResourceServer, ausdPaymentOption, x402HTTPResourceServer, ExpressAdapter, requestContext, type RoutesConfig, type HTTPRequestContext } from './x402server';
import { basescanTx } from '@idle/shared';

export interface GateQuote {
  payTo: string;
  amount: bigint;
  /** JSON body to send with the 402 (e.g. { error: 'PAYMENT_REQUIRED', quote }) */
  body402: unknown;
}

export interface GateVerified {
  kind: 'verified';
  payer?: string;
  /** EIP-3009 authorization the facilitator verified (undefined for non-EIP-3009 payloads) */
  authorization?: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
  /** Settle now (after the work passed verification). Sets the PAYMENT-RESPONSE header on success. */
  settle: () => Promise<{ success: true; txHash: string; explorerUrl: string; payer?: string } | { success: false; reason: string; message?: string }>;
  /** Do not settle (work failed verification). */
  abandon: (reason: string) => Promise<void>;
}
export type GateOutcome = GateVerified | { kind: 'responded'; status: number };

export function createAusdGate(opts: { routePattern: string; facilitatorUrl?: string; maxTimeoutSeconds?: number; description?: string }) {
  const quotes = new WeakMap<Request, GateQuote>();
  const quoteFor = (ctx: HTTPRequestContext): GateQuote | undefined => {
    const req = (ctx.adapter as ExpressAdapter).req;
    return req ? quotes.get(req) : undefined;
  };
  const server = createResourceServer(opts.facilitatorUrl);
  const routes: RoutesConfig = {
    [opts.routePattern]: {
      description: opts.description ?? 'Idle compute job',
      mimeType: 'application/json',
      accepts: ausdPaymentOption({
        payTo: (ctx) => quoteFor(ctx)?.payTo ?? '0x0000000000000000000000000000000000000000',
        amount: (ctx) => quoteFor(ctx)?.amount ?? 0n,
        maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 120,
      }),
      unpaidResponseBody: (ctx) => ({ contentType: 'application/json', body: quoteFor(ctx)?.body402 ?? { error: 'PAYMENT_REQUIRED' } }),
    },
  };
  const http = new x402HTTPResourceServer(server, routes);
  let initialized: Promise<void> | null = null;
  const initialize = () => (initialized ??= http.initialize());

  /**
   * Runs the x402 flow for this request. Either responds itself (402 / payment error) and returns
   * { kind: 'responded' }, or returns { kind: 'verified' } with a deferred settle().
   */
  async function check(req: Request, res: Response, quote: GateQuote): Promise<GateOutcome> {
    await initialize();
    if (!quote || !quote.payTo || quote.amount <= 0n) {
      res.status(500).json({ error: 'GATE_NO_QUOTE' });
      return { kind: 'responded', status: 500 };
    }
    quotes.set(req, quote);
    const ctx = requestContext(req);
    const result = await http.processHTTPRequest(ctx);
    if (result.type === 'no-payment-required') {
      // route not matched by the x402 server; treat as misconfiguration
      res.status(500).json({ error: 'GATE_MISCONFIGURED', routePattern: opts.routePattern });
      return { kind: 'responded', status: 500 };
    }
    if (result.type === 'payment-error') {
      res.status(result.response.status);
      for (const [k, v] of Object.entries(result.response.headers)) res.setHeader(k, v);
      if (result.response.isHtml) res.send(result.response.body);
      else res.json(result.response.body ?? {});
      return { kind: 'responded', status: result.response.status };
    }
    const { paymentPayload, paymentRequirements, declaredExtensions, cancellationDispatcher } = result;
    const authorization = (paymentPayload.payload as { authorization?: GateVerified['authorization'] })?.authorization;
    const payer = authorization?.from;
    return {
      kind: 'verified',
      payer,
      authorization,
      settle: async () => {
        const s = await http.processSettlement(paymentPayload, paymentRequirements, declaredExtensions, { request: ctx });
        if (!s.success) return { success: false, reason: s.errorReason, message: s.errorMessage };
        for (const [k, v] of Object.entries(s.headers)) res.setHeader(k, v);
        return { success: true, txHash: s.transaction, explorerUrl: basescanTx(s.transaction), payer: s.payer };
      },
      abandon: async (reason) => {
        try {
          await cancellationDispatcher.cancel({ reason: 'handler_error', message: reason } as never);
        } catch {
          /* nothing was settled; the authorization simply expires */
        }
      },
    };
  }

  return { check, initialize, http, server };
}

export type { SettleResponse };
