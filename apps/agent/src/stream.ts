/**
 * XRPL streaming rail (buyer side): quote → credential check → channel → WS → tokens with cumulative claims.
 * The agent pays for exactly the tokens it received and can stop at any time.
 */
import WebSocket from 'ws';
import type { Wallet } from 'xrpl';
import { findUsableChannel, openChannel, getChannel, signClaim, hasValidCredential } from '@idle/pay-xrpl';
import { formatUnits, xrplTx, type CreateStreamRequest, type StreamQuote, type StreamServerMessage, type StreamClientMessage } from '@idle/shared';
import type { AgentLogger } from './log';
import type { Persona } from './personas';
import { MarketError } from './market';

export class XrpBudget {
  authorized = 0n;
  constructor(readonly budget: bigint) {}
  get remaining() {
    return this.budget - this.authorized;
  }
}

export interface StreamOptions {
  maxTokens: number;
  maxDropsPerToken?: bigint;
  ceiling?: bigint;
  deadlineMs?: number;
  /** stop early after this many tokens (the demo moment) */
  stopAfterTokens?: number;
  /** stop early when this predicate says the text is complete */
  stopWhen?: (text: string, tokens: number) => boolean;
  onToken?: (token: string, index: number) => void;
  model?: string;
}

export interface StreamOutcome {
  text: string;
  tokens: number;
  dropsPerToken: bigint;
  dropsPaid: bigint;
  claimTx?: string;
  channelId: string;
  providerName: string;
  stopped: boolean;
  quote: StreamQuote;
}

const CLAIM_EVERY = 16;

export async function streamGeneration(
  ctx: { exchangeUrl: string; wallet: Wallet; issuer: string; persona: Persona; log: AgentLogger; budget: XrpBudget },
  prompt: string,
  opts: StreamOptions,
): Promise<StreamOutcome> {
  const { log, persona } = ctx;
  let maxDrops = opts.maxDropsPerToken ?? persona.stream.open;
  const ceiling = opts.ceiling ?? persona.stream.ceiling;
  let quote: StreamQuote | undefined;
  for (let attempt = 1; attempt <= persona.maxRetries && !quote; attempt++) {
    const body: CreateStreamRequest = {
      prompt,
      model: opts.model,
      maxTokens: opts.maxTokens,
      maxDropsPerToken: maxDrops.toString(),
      deadlineMs: opts.deadlineMs ?? persona.deadlineMs,
      persona: persona.name,
      agentId: log.agentId,
    };
    log.action(`stream quote: ${opts.maxTokens} tokens at ≤ ${maxDrops} drops/token`);
    const r = await fetch(`${ctx.exchangeUrl}/v1/streams`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status === 200) {
      quote = json as unknown as StreamQuote;
      break;
    }
    if (r.status === 409) {
      const suggested = json.suggestedMaxUnitPrice ? BigInt(String(json.suggestedMaxUnitPrice)) : maxDrops * 2n;
      const next = suggested < ceiling ? suggested : ceiling;
      if (next <= maxDrops) throw new MarketError('no acceptable stream bid under ceiling', 'NO_ACCEPTABLE_BID', json);
      log.thought(`outbid at ${maxDrops} drops/token → raising to ${next}`);
      maxDrops = next;
      continue;
    }
    if (r.status === 503) {
      await new Promise((res) => setTimeout(res, Number(json.retryAfterMs ?? 1000)));
      continue;
    }
    throw new MarketError(`stream quote failed ${r.status}: ${JSON.stringify(json)}`, 'HTTP', json);
  }
  if (!quote) throw new MarketError('no stream quote', 'RETRIES');
  const dropsPerToken = BigInt(quote.dropsPerToken);
  log.thought(`${quote.providerName} won the stream at ${dropsPerToken} drops/token`);

  // trustless check before paying
  const credOk = (await hasValidCredential(quote.providerXrplAddress, ctx.issuer, 'IDLE_DC_TIER_A')) || (await hasValidCredential(quote.providerXrplAddress, ctx.issuer, 'IDLE_DC_TIER_B'));
  if (!credOk) throw new MarketError(`winner ${quote.providerName} not credentialed on-ledger`, 'NOT_CREDENTIALED');

  const need = dropsPerToken * BigInt(opts.maxTokens);
  if (need > ctx.budget.remaining) throw new MarketError(`XRP budget: need ${need} drops, remaining ${ctx.budget.remaining}`, 'BUDGET');

  // channel: reuse or open 10 XRP (or 2× need if larger)
  let channel = await findUsableChannel(ctx.wallet.address, quote.providerXrplAddress, need);
  if (!channel) {
    const amount = need * 2n > 10_000_000n ? need * 2n : 10_000_000n;
    log.action(`opening a ${formatUnits(amount, 6)} XRP payment channel to ${quote.providerName}`);
    const opened = await openChannel(ctx.wallet, quote.providerXrplAddress, amount, 60);
    log.result(`channel ${opened.channelId.slice(0, 12)}… open  ${xrplTx(opened.txHash)}`);
    channel = await getChannel(opened.channelId);
    if (!channel) throw new MarketError('channel not found after open', 'CHANNEL');
  } else {
    log.thought(`reusing channel ${channel.channelId.slice(0, 12)}… (${formatUnits(channel.amountDrops - channel.balanceDrops, 6)} XRP unclaimed)`);
  }
  const prior = channel.balanceDrops;
  const channelId = channel.channelId;

  const wsUrl = `${ctx.exchangeUrl.replace(/^http/, 'ws')}/v1/streams/${quote.quoteId}`;
  const ws = new WebSocket(wsUrl);
  const send = (m: StreamClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

  let text = '';
  let tokens = 0;
  let claimedTokens = 0;
  let dropsAuthorized = 0n;
  let stopped = false;
  let stopSent = false;
  let claimTx: string | undefined;
  let endSeen = false;

  const claim = (why: string) => {
    if (tokens === claimedTokens) return;
    const cumulative = prior + dropsPerToken * BigInt(tokens);
    const sig = signClaim(ctx.wallet, channelId, cumulative);
    send({ type: 'claim', amountDrops: cumulative.toString(), signature: sig });
    const delta = dropsPerToken * BigInt(tokens - claimedTokens);
    ctx.budget.authorized += delta;
    dropsAuthorized = dropsPerToken * BigInt(tokens);
    claimedTokens = tokens;
    log.spend(`signed claim ${cumulative} drops (${tokens} tokens × ${dropsPerToken}) ${why}`, { channelId, amountDrops: cumulative.toString(), tokens });
  };
  const stop = (why: string) => {
    if (stopSent) return;
    stopped = true;
    stopSent = true;
    claim('final');
    send({ type: 'stop' });
    log.action(`stopping stream at ${tokens} tokens: ${why}`);
  };

  const outcome = await new Promise<StreamOutcome>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MarketError('stream timeout', 'TIMEOUT')), 180_000);
    const finish = () => {
      clearTimeout(timer);
      ws.close();
      resolve({ text, tokens, dropsPerToken, dropsPaid: dropsAuthorized, claimTx, channelId, providerName: quote!.providerName, stopped, quote: quote! });
    };
    let claimedWait: NodeJS.Timeout | undefined;
    ws.on('open', () => {
      send({ type: 'open', channelId, publicKey: ctx.wallet.publicKey, buyerAddress: ctx.wallet.address, priorClaimedDrops: prior.toString() });
    });
    ws.on('message', (raw) => {
      let m: StreamServerMessage;
      try {
        m = JSON.parse(String(raw)) as StreamServerMessage;
      } catch {
        return;
      }
      switch (m.type) {
        case 'started':
          log.result(`stream started with ${quote!.providerName}`);
          break;
        case 'token':
          if (endSeen || stopSent) return;
          text += m.token;
          tokens++;
          opts.onToken?.(m.token, m.index);
          if (tokens - claimedTokens >= CLAIM_EVERY) claim('(every 16 tokens)');
          if (opts.stopAfterTokens && tokens >= opts.stopAfterTokens) stop(`stopAfterTokens=${opts.stopAfterTokens}`);
          else if (opts.stopWhen?.(text, tokens)) stop('answer complete');
          break;
        case 'paused':
          claim('(provider paused: credit window)');
          break;
        case 'end':
          endSeen = true;
          claim('final');
          log.result(`stream ended (${m.reason}) after ${m.tokensDelivered} tokens`);
          claimedWait = setTimeout(finish, 45_000); // provider submits the on-ledger claim; wait for `claimed`
          break;
        case 'claimed':
          claimTx = m.txHash;
          log.result(`provider claimed ${m.drops} drops for ${m.tokens} tokens on-ledger  ${m.explorerUrl}`);
          if (claimedWait) clearTimeout(claimedWait);
          finish();
          break;
        case 'error':
          clearTimeout(timer);
          reject(new MarketError(`${m.code}: ${m.message}`, m.code));
          break;
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ws.on('close', () => {
      if (endSeen) finish();
    });
  });
  return outcome;
}
