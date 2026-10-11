import { x402ResourceServer, HTTPFacilitatorClient, x402HTTPResourceServer } from '@x402/core/server';
import type { HTTPAdapter, HTTPRequestContext, PaymentOption, RoutesConfig } from '@x402/core/http';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import type { Request } from 'express';
import { BASE_SEPOLIA_CAIP2 } from '@idle/shared';
import { ausdAddress, ausdDomainFromEnv } from './ausd';

export { x402HTTPResourceServer };
export type { HTTPRequestContext, PaymentOption, RoutesConfig };

/** Resource server pointing at our own facilitator. */
export function createResourceServer(facilitatorUrl = process.env.FACILITATOR_URL ?? 'http://localhost:4022'): x402ResourceServer {
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl, timeoutMs: 90_000 }));
  registerExactEvmScheme(server, { networks: [BASE_SEPOLIA_CAIP2] });
  return server;
}

type Dyn<T> = T | ((ctx: HTTPRequestContext) => T | Promise<T>);

/**
 * An `exact` payment option priced in AUSD atomic units with the token's EIP-712 domain in `extra`
 * (required for custom EIP-3009 assets). `payTo` and `amount` may be functions of the request so the
 * exchange can quote per auction.
 */
export function ausdPaymentOption(args: { payTo: Dyn<string>; amount: Dyn<bigint>; maxTimeoutSeconds?: number }): PaymentOption {
  const { name, version } = ausdDomainFromEnv();
  const asset = ausdAddress();
  const toPrice = (amount: bigint) => ({ asset, amount: amount.toString(), extra: { name, version } });
  const price =
    typeof args.amount === 'function'
      ? async (ctx: HTTPRequestContext) => toPrice(await (args.amount as (c: HTTPRequestContext) => bigint | Promise<bigint>)(ctx))
      : toPrice(args.amount);
  return {
    scheme: 'exact',
    network: BASE_SEPOLIA_CAIP2,
    payTo: args.payTo as PaymentOption['payTo'],
    price,
    maxTimeoutSeconds: args.maxTimeoutSeconds ?? 120,
  };
}

/** Mirrors @x402/express's adapter so the stock @x402/fetch client works unmodified. */
export class ExpressAdapter implements HTTPAdapter {
  constructor(readonly req: Request) {}
  getHeader(name: string): string | undefined {
    const v = this.req.header(name);
    return Array.isArray(v) ? v[0] : v;
  }
  getMethod(): string {
    return this.req.method;
  }
  getPath(): string {
    return this.req.path;
  }
  getUrl(): string {
    return `${this.req.protocol}://${this.req.headers.host}${this.req.originalUrl}`;
  }
  getAcceptHeader(): string {
    return this.req.header('Accept') ?? '';
  }
  getUserAgent(): string {
    return this.req.header('User-Agent') ?? '';
  }
  getQueryParams(): Record<string, string | string[]> {
    return this.req.query as Record<string, string | string[]>;
  }
  getQueryParam(name: string): string | string[] | undefined {
    return this.req.query[name] as string | string[] | undefined;
  }
  getBody(): unknown {
    return this.req.body;
  }
}

export function requestContext(req: Request): HTTPRequestContext {
  const adapter = new ExpressAdapter(req);
  return {
    adapter,
    path: req.path,
    decodedPath: safeDecode(req.path),
    method: req.method,
    paymentHeader: adapter.getHeader('payment-signature') ?? adapter.getHeader('x-payment'),
  };
}

function safeDecode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}
