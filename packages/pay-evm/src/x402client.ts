import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { Hex } from 'viem';
import { BASE_SEPOLIA_CAIP2 } from '@idle/shared';
import { accountFromKey } from './chain';
import { ausdAddress } from './ausd';

export interface SpendEvent {
  ok: boolean;
  amount: bigint;
  payTo: string;
  txHash?: string;
  reason?: string;
  url: string;
}

export interface SpendPolicy {
  /** Hard cap per payment, atomic AUSD. */
  maxPerPayment: bigint;
  /** Cumulative budget for this agent, atomic AUSD. */
  budget: bigint;
  /** Called with the server's quoted payee before anything is signed. */
  isPayeeAllowed?: (payTo: string, req: PaymentRequirements) => boolean | Promise<boolean>;
  onSpend?: (e: SpendEvent) => void;
}

export class SpendTracker {
  spent = 0n;
  reserved = 0n;
  constructor(public budget: bigint) {}
  get remaining(): bigint {
    return this.budget - this.spent - this.reserved;
  }
}

export interface PaidResult {
  response: Response;
  /** true when a payment header was sent on the retry */
  paid: boolean;
  settlement?: SettleResponse;
  amount?: bigint;
  payTo?: string;
  abortReason?: string;
}

const safeBig = (s: string): bigint => {
  try {
    return BigInt(s);
  } catch {
    return -1n;
  }
};

/**
 * x402 buyer client for AUSD on Base Sepolia.
 * - Opts AUSD into x402's spend controls (non-default assets are blocked otherwise).
 * - A payment policy filters the server's own requirements (asset, network, scheme, per-payment max).
 * - A per-call client enforces budget + payee allow-list in onBeforePaymentCreation, so it runs
 *   against the real 402 and never against a number we chose ourselves.
 */
export function createPaidFetch(opts: { privateKey: Hex; policy: SpendPolicy; baseFetch?: typeof fetch }) {
  const account = accountFromKey(opts.privateKey);
  const asset = ausdAddress();
  const tracker = new SpendTracker(opts.policy.budget);
  const baseFetch = opts.baseFetch ?? fetch;
  const { policy } = opts;

  const buildClient = (state: { amount?: bigint; payTo?: string; abortReason?: string }) => {
    const client = x402Client.fromConfig({
      schemes: [{ network: BASE_SEPOLIA_CAIP2, client: new ExactEvmScheme(account) }],
      spendControls: {
        allowedAssets: [{ network: BASE_SEPOLIA_CAIP2, asset, maxAmountPerPayment: policy.maxPerPayment.toString() }],
        maxAmountPerPayment: false,
      },
      policies: [
        (_v, reqs) =>
          reqs.filter(
            (r) =>
              r.scheme === 'exact' &&
              r.network === BASE_SEPOLIA_CAIP2 &&
              r.asset.toLowerCase() === asset.toLowerCase() &&
              safeBig(r.amount) >= 0n &&
              safeBig(r.amount) <= policy.maxPerPayment &&
              r.maxTimeoutSeconds <= 300,
          ),
      ],
    });
    client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
      const amount = safeBig(r.amount);
      if (amount < 0n || amount > policy.maxPerPayment) {
        state.abortReason = `amount ${r.amount} exceeds per-payment max ${policy.maxPerPayment}`;
        return { abort: true, reason: state.abortReason };
      }
      if (amount > tracker.remaining) {
        state.abortReason = `budget exhausted: need ${amount}, remaining ${tracker.remaining}`;
        return { abort: true, reason: state.abortReason };
      }
      // reserve before any await so concurrent calls cannot all pass the budget check
      tracker.reserved += amount;
      state.amount = amount;
      state.payTo = r.payTo;
      if (policy.isPayeeAllowed && !(await policy.isPayeeAllowed(r.payTo, r))) {
        tracker.reserved -= amount;
        state.amount = undefined;
        state.abortReason = `payee ${r.payTo} not allowed`;
        return { abort: true, reason: state.abortReason };
      }
    });
    return client;
  };

  async function payFetch(url: string, init?: RequestInit): Promise<PaidResult> {
    const state: { amount?: bigint; payTo?: string; abortReason?: string } = {};
    const client = buildClient(state);
    let paid = false;
    const tracking: typeof fetch = async (input, reqInit) => {
      const req = new Request(input, reqInit);
      if (req.headers.has('PAYMENT-SIGNATURE')) paid = true;
      return baseFetch(req);
    };
    let response: Response;
    try {
      response = await wrapFetchWithPayment(tracking, client)(url, init);
    } catch (e) {
      if (state.amount !== undefined) tracker.reserved -= state.amount;
      if (state.abortReason) {
        policy.onSpend?.({ ok: false, amount: state.amount ?? 0n, payTo: state.payTo ?? '', reason: state.abortReason, url });
        return { response: new Response(JSON.stringify({ error: state.abortReason }), { status: 402 }), paid: false, abortReason: state.abortReason };
      }
      throw e;
    }
    let settlement: SettleResponse | undefined;
    const hdr = response.headers.get('PAYMENT-RESPONSE');
    if (hdr) {
      try {
        settlement = decodePaymentResponseHeader(hdr);
      } catch {
        /* ignore */
      }
    }
    if (state.amount !== undefined) {
      tracker.reserved -= state.amount;
      if (settlement?.success) {
        tracker.spent += state.amount;
        policy.onSpend?.({ ok: true, amount: state.amount, payTo: state.payTo!, txHash: settlement.transaction, url });
      } else if (paid) {
        policy.onSpend?.({
          ok: false,
          amount: state.amount,
          payTo: state.payTo!,
          reason: settlement?.errorReason ?? `http ${response.status} without settlement`,
          url,
        });
      }
    }
    return { response, paid, settlement, amount: state.amount, payTo: state.payTo, abortReason: state.abortReason };
  }

  return { payFetch, tracker, address: account.address, account };
}
