/**
 * Buyer-side market client: x402 rail (AUSD per job) with the trustless credential check,
 * the plan's retry policy on 409/503, and spend logging.
 */
import { randomUUID } from 'node:crypto';
import { createPaidFetch, type SpendTracker } from '@idle/pay-evm';
import { hasValidCredential } from '@idle/pay-xrpl';
import { formatUnits, type CreateJobRequest, type JobResult, type MarketSnapshot, type Quote, type BidView } from '@idle/shared';
import type { Hex } from 'viem';
import type { AgentLogger } from './log';
import type { Persona } from './personas';

export class MarketError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export interface BuyOptions {
  maxUnitPrice?: bigint;
  ceiling?: bigint;
  deadlineMs?: number;
  minTier?: 'A' | 'B';
  model?: string;
}

export interface Purchase {
  result: JobResult;
  quote?: Quote;
  paid: boolean;
  amount: bigint;
  attempts: number;
}

export class MarketClient {
  private paid: ReturnType<typeof createPaidFetch>;
  readonly tracker: SpendTracker;
  private issuer?: string;
  readonly address: string;
  private lastQuote?: Quote;
  readonly receipts: Array<{ amount: bigint; payTo: string; txHash: string; explorerUrl: string }> = [];
  jobsBought = 0;

  constructor(
    private exchangeUrl: string,
    evmKey: Hex,
    budget: bigint,
    private persona: Persona,
    private log: AgentLogger,
  ) {
    const ceiling = persona.generate.ceiling * 256n > persona.embed.ceiling * 64n ? persona.generate.ceiling * 256n : persona.embed.ceiling * 64n;
    this.paid = createPaidFetch({
      privateKey: evmKey,
      policy: {
        maxPerPayment: ceiling,
        budget,
        // the payee must be the quoted winner AND the amount must be exactly the quoted amount
        isPayeeAllowed: (payTo, req) => !!this.lastQuote && payTo.toLowerCase() === this.lastQuote.payTo.toLowerCase() && req.amount === this.lastQuote.amount,
        onSpend: (e) => {
          if (e.ok && e.txHash) this.receipts.push({ amount: e.amount, payTo: e.payTo, txHash: e.txHash, explorerUrl: `https://sepolia.basescan.org/tx/${e.txHash}` });
          if (e.ok) this.log.spend(`paid ${formatUnits(e.amount, 6, 4)} AUSD → ${short(e.payTo)}  tx ${e.txHash}`, { amount: e.amount.toString(), payTo: e.payTo, txHash: e.txHash });
          else this.log.error(`payment not settled (${e.reason}); not charged`, { amount: e.amount.toString(), payTo: e.payTo });
        },
      },
    });
    this.tracker = this.paid.tracker;
    this.address = this.paid.address;
  }

  async snapshot(): Promise<MarketSnapshot> {
    const r = await fetch(`${this.exchangeUrl}/v1/market`);
    if (!r.ok) throw new MarketError(`market snapshot failed: ${r.status}`, 'MARKET_DOWN');
    const snap = (await r.json()) as MarketSnapshot;
    this.issuer = snap.issuer;
    return snap;
  }

  budget() {
    return { spent: this.tracker.spent, remaining: this.tracker.remaining, budget: this.tracker.budget };
  }

  /** Reads the ledger directly: does the quoted winner hold an accepted Idle credential from the exchange's issuer? */
  private async winnerIsCredentialed(q: Quote): Promise<boolean> {
    if (!this.issuer) await this.snapshot();
    if (!this.issuer) return false;
    for (const t of ['IDLE_DC_TIER_A', 'IDLE_DC_TIER_B']) {
      if (await hasValidCredential(q.providerXrplAddress, this.issuer, t)) return true;
    }
    return false;
  }

  async buyEmbeddings(texts: string[], opts: BuyOptions = {}): Promise<Purchase> {
    if (texts.length > 64) throw new MarketError('max 64 texts per job', 'TOO_MANY');
    return this.buy({ jobType: 'embed', input: { texts }, units: texts.length, price: this.persona.embed, ...opts });
  }

  async buyGeneration(prompt: string, maxTokens: number, opts: BuyOptions = {}): Promise<Purchase> {
    return this.buy({ jobType: 'generate', input: { prompt, maxTokens }, units: maxTokens, price: this.persona.generate, ...opts });
  }

  private async buy(args: {
    jobType: 'embed' | 'generate';
    input: CreateJobRequest['input'];
    units: number;
    price: { open: bigint; ceiling: bigint };
    maxUnitPrice?: bigint;
    ceiling?: bigint;
    deadlineMs?: number;
    minTier?: 'A' | 'B';
    model?: string;
  }): Promise<Purchase> {
    let maxUnitPrice = args.maxUnitPrice ?? args.price.open;
    const ceiling = args.ceiling ?? args.price.ceiling;
    // generation deadlines scale with length (assume a slow laptop does ~8 tok/s); embeds use the persona deadline
    let deadlineMs = args.deadlineMs ?? (args.jobType === 'generate' ? Math.max(this.persona.deadlineMs, Math.ceil(args.units / 8) * 1000 + 3000) : this.persona.deadlineMs);
    const unit = args.jobType === 'embed' ? 'text' : 'token';
    for (let attempt = 1; attempt <= this.persona.maxRetries; attempt++) {
      const body: CreateJobRequest = {
        jobType: args.jobType,
        model: args.model,
        input: args.input,
        maxUnitPrice: maxUnitPrice.toString(),
        deadlineMs,
        minTier: args.minTier,
        persona: this.persona.name,
        agentId: this.log.agentId,
      };
      const key = randomUUID();
      const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) };
      const url = `${this.exchangeUrl}/v1/jobs`;
      this.log.action(`bidding ${args.units} ${unit}s of ${args.jobType} at ≤ ${maxUnitPrice} µAUSD/${unit}, deadline ${deadlineMs} ms`);
      const first = await fetch(url, init);
      if (first.status === 200) {
        const result = (await first.json()) as JobResult;
        this.jobsBought++;
        this.log.result(`${args.jobType} done by ${result.providerName} in ${result.latencyMs} ms (payments off)`);
        return { result, paid: false, amount: 0n, attempts: attempt };
      }
      const json = (await first.json().catch(() => ({}))) as Record<string, unknown>;
      if (first.status === 402) {
        const quote = (json as { quote: Quote }).quote;
        this.lastQuote = quote;
        const bids = (quote.bids ?? []).filter((b: BidView) => b.valid).length;
        this.log.thought(`${bids} bids; ${quote.providerName} won at ${quote.unitPrice} µAUSD/${unit} (2nd price) → ${formatUnits(BigInt(quote.amount), 6, 4)} AUSD`);
        if (!(await this.winnerIsCredentialed(quote))) {
          this.log.error(`winner ${quote.providerName} has no valid XRPL credential on-ledger — refusing to pay`);
          throw new MarketError('winner not credentialed', 'NOT_CREDENTIALED', quote);
        }
        const paid = await this.paid.payFetch(url, init);
        if (paid.response.status === 200) {
          const result = (await paid.response.json()) as JobResult;
          this.jobsBought++;
          this.log.result(`${args.jobType} verified${result.verification.cosine !== undefined ? ` (cosine ${result.verification.cosine.toFixed(4)})` : ''}; settled ${formatUnits(BigInt(quote.amount), 6, 4)} AUSD to ${quote.providerName}`);
          return { result, quote, paid: true, amount: BigInt(quote.amount), attempts: attempt };
        }
        const err = (await paid.response.json().catch(() => ({}))) as Record<string, unknown>;
        if (paid.response.status === 502 && err.error === 'PROVIDER_FAILED_VERIFICATION') {
          this.log.error(`${quote.providerName} failed verification — not charged; re-auctioning`);
          continue;
        }
        if (paid.abortReason) throw new MarketError(paid.abortReason, 'POLICY');
        throw new MarketError(`paid request failed: ${paid.response.status} ${JSON.stringify(err)}`, 'PAY_FAILED', err);
      }
      if (first.status === 409) {
        const suggested = json.suggestedMaxUnitPrice ? BigInt(String(json.suggestedMaxUnitPrice)) : maxUnitPrice * 2n;
        const best = json.bestBid as BidView | undefined;
        if (best?.reason === 'eta_exceeds_deadline' && deadlineMs < 180_000) {
          deadlineMs = Math.min(Math.max(deadlineMs * 2, Math.ceil((best.etaMs ?? deadlineMs) * 1.3)), 180_000);
          this.log.thought(`no provider can finish in ${unit === 'token' ? 'time' : 'time'}; extending the deadline to ${deadlineMs} ms`);
          continue;
        }
        if (this.persona.patient && attempt < this.persona.maxRetries) {
          this.log.thought(`outbid at ${maxUnitPrice} (best ask ${best?.unitPrice ?? '?'}); waiting ${this.persona.waitMs} ms for cheaper supply`);
          await sleep(this.persona.waitMs);
          if (attempt % 2 === 0) maxUnitPrice = minBig((maxUnitPrice * 115n) / 100n + 1n, ceiling);
          continue;
        }
        const next = minBig(suggested, ceiling);
        if (next <= maxUnitPrice) throw new MarketError(`no acceptable bid under ceiling ${ceiling}`, 'NO_ACCEPTABLE_BID', json);
        this.log.thought(`outbid at ${maxUnitPrice} µAUSD/${unit} → raising to ${next}`);
        maxUnitPrice = next;
        continue;
      }
      if (first.status === 503 || first.status === 429) {
        const wait = Number(json.retryAfterMs ?? 1000);
        this.log.thought(`${first.status === 429 ? 'rate limited' : 'no free capacity'}; retrying in ${wait} ms`);
        await sleep(wait);
        continue;
      }
      throw new MarketError(`unexpected ${first.status}: ${JSON.stringify(json)}`, 'HTTP', json);
    }
    throw new MarketError('gave up after retries', 'RETRIES');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
