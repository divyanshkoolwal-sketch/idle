/**
 * The buyer agent: a Claude tool-use loop. Claude decides queries, which pages to keep, bid prices,
 * the rail for the final answer and when to stop streaming. The pipeline shape is fixed by the tools.
 */
import Anthropic from '@anthropic-ai/sdk';
import { formatUnits } from '@idle/shared';
import type { MarketClient } from './market';
import type { AgentLogger } from './log';
import type { Persona } from './personas';
import { chunkMarkdown, rankChunks, buildAnswerPrompt, type Chunk } from './research';
import { webSearch, scrape } from './tools/context';
import { streamGeneration, type StreamOptions, type StreamOutcome, type XrpBudget } from './stream';
import type { Wallet } from 'xrpl';

export interface AgentDeps {
  market: MarketClient;
  log: AgentLogger;
  persona: Persona;
  model: string;
  effort: 'low' | 'medium' | 'high';
  exchangeUrl: string;
  wallet: Wallet;
  issuer: string;
  xrp: XrpBudget;
  genModel: string;
}

export interface AgentTask {
  question?: string;
  indexUrl?: string;
  stopAfterTokens?: number;
}

export interface AgentOutcome {
  answer?: string;
  sources: string[];
  iterations: number;
  stream?: StreamOutcome;
}

interface Workspace {
  pages: Map<string, { title: string; chunks: Chunk[]; links: string[] }>;
  vectors: Map<number, number[]>;
  queryVec?: number[];
  ranked: Array<Chunk & { score: number }>;
  answer?: string;
  lastStream?: StreamOutcome;
  nextChunkId: number;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'market_snapshot',
    description: 'Current Idle market: data centers online/verified, free capacity, recent clearing prices per job type (atomic units), and the bid-depth curve of current asks.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: 'web_search',
    description: 'Context.dev web search. Returns numbered results with title, url, description and relevance.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, numResults: { type: 'integer', minimum: 3, maximum: 10 } }, required: ['query', 'numResults'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'scrape',
    description: 'Scrape a URL to markdown (main content only) and keep it in the workspace, split into ~800-character chunks ready for embedding. Returns the chunk count, a preview and outgoing links.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'buy_embeddings',
    description:
      'Buy embeddings on the x402/AUSD rail for every workspace chunk not yet embedded, plus the query. maxUnitPrice is your bid in micro-AUSD per text (1 AUSD = 1,000,000). The exchange runs a sealed-bid second-price auction; if nobody accepts your price you get an error with a suggested price and may bid again. Ranks the chunks by similarity to the query and returns the top ones.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, maxUnitPrice: { type: 'integer', minimum: 1 }, deadlineMs: { type: 'integer', minimum: 500, maximum: 120000 } },
      required: ['query', 'maxUnitPrice', 'deadlineMs'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'buy_generation',
    description:
      'Generate the cited final answer from the ranked chunks. rail "x402" pays AUSD up front for maxTokens (fixed price per token, maxUnitPrice in micro-AUSD/token). rail "stream" pays XRP per delivered token over an XRPL payment channel (maxUnitPrice in drops/token) and can stop early: set stopAfterTokens to cut the stream once enough has arrived, or null to let it finish. Returns the text and what was paid.',
    input_schema: {
      type: 'object',
      properties: {
        rail: { type: 'string', enum: ['x402', 'stream'] },
        maxTokens: { type: 'integer', minimum: 32, maximum: 512 },
        maxUnitPrice: { type: 'integer', minimum: 1 },
        stopAfterTokens: { type: ['integer', 'null'], minimum: 16 },
      },
      required: ['rail', 'maxTokens', 'maxUnitPrice', 'stopAfterTokens'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'budget',
    description: 'Spent and remaining budget in AUSD and XRP.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: 'finish',
    description: 'Finish with the final answer (for research) or a summary (for indexing). Call this exactly once at the end.',
    input_schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
    strict: true,
  },
];

function systemPrompt(p: Persona, task: AgentTask, genModel: string): string {
  const pricing = `Your persona: ${p.name} — ${p.description}
Bidding guidance (micro-AUSD per unit unless noted): embeddings open ${p.embed.open}, ceiling ${p.embed.ceiling}; generation open ${p.generate.open}, ceiling ${p.generate.ceiling}; stream open ${p.stream.open} drops/token, ceiling ${p.stream.ceiling}. Deadline you tolerate: ${p.deadlineMs} ms. ${p.patient ? 'You are patient: when outbid, prefer waiting for cheaper supply over paying up.' : 'You are urgent: when outbid, raise quickly toward the ceiling.'} Preferred rail for the final answer: ${p.finalAnswerRail}.`;
  const shape =
    task.indexUrl
      ? `Task: index ${task.indexUrl}. Scrape it, then scrape up to 6 of its most relevant outgoing links, buy embeddings for everything (batches are handled for you), and finish with a one-paragraph summary of what was indexed and what it cost.`
      : `Task: answer the research question with citations. Pipeline: (1) web_search once or twice with sharp queries, (2) scrape the 3–5 most promising results, (3) buy_embeddings with the question as the query, (4) buy_generation on rail "${p.finalAnswerRail}" (the generation model is ${genModel}, a small local model: keep maxTokens ≤ 256${p.finalAnswerRail === 'stream' ? ' and stop early once the answer looks complete, e.g. stopAfterTokens around 150' : ''}), (5) finish with the answer followed by a "Sources:" list of URLs.`;
  return `You are an autonomous buyer agent on Idle, a spot market where AI agents bid for GPU time from data centers. You pay per job with real testnet money, so be deliberate about prices.
${pricing}
${shape}
Before each tool call write ONE short line (under 20 words) saying what you are doing and why, like a terminal log. No markdown headers. If a purchase fails with a suggested price, decide whether to raise or wait, and say so. Never exceed the ceilings.`;
}

export async function runClaudeAgent(deps: AgentDeps, task: AgentTask): Promise<AgentOutcome> {
  const { log, persona, market } = deps;
  const client = new Anthropic();
  const ws: Workspace = { pages: new Map(), vectors: new Map(), ranked: [], nextChunkId: 0 };
  const sources = new Set<string>();
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task.indexUrl ? `Index ${task.indexUrl}` : task.question ?? 'Hello' }];
  const system = systemPrompt(persona, task, deps.genModel);
  let iterations = 0;
  let finished: string | undefined;

  const run = async (name: string, input: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case 'market_snapshot': {
        const s = await market.snapshot();
        const online = s.providers.filter((p) => p.online);
        return JSON.stringify({
          providersOnline: online.length,
          providersVerified: online.filter((p) => p.status === 'verified').length,
          slots: { total: s.stats.slotsTotal, busy: s.stats.slotsBusy },
          clearing: s.stats.clearing,
          asks: Object.fromEntries(Object.entries(s.depth).map(([k, v]) => [k, v.slice(0, 6)])),
          providers: online.map((p) => ({ name: p.name, tier: p.tier, status: p.status, busy: `${p.busySlots}/${p.slots}`, asks: p.asks, strikes: p.strikes })),
        });
      }
      case 'web_search': {
        const hits = await webSearch(String(input.query), Number(input.numResults ?? 8));
        return JSON.stringify(hits.map((h, i) => ({ i: i + 1, ...h, description: h.description.slice(0, 160) })));
      }
      case 'scrape': {
        const url = String(input.url);
        const page = await scrape(url);
        const title = page.markdown.match(/^#\s+(.+)$/m)?.[1] ?? new URL(url).hostname;
        const chunks = chunkMarkdown(url, title, page.markdown, 800, ws.nextChunkId);
        ws.nextChunkId += chunks.length;
        const links = [...new Set((page.markdown.match(/https?:\/\/[^\s)\]"']+/g) ?? []).filter((l) => !l.includes(new URL(url).hostname) || true))].slice(0, 15);
        ws.pages.set(url, { title, chunks, links });
        sources.add(url);
        return JSON.stringify({ url, title, chunks: chunks.length, chars: page.markdown.length, truncated: page.truncated, preview: page.markdown.slice(0, 300), links });
      }
      case 'buy_embeddings': {
        const query = String(input.query);
        const maxUnitPrice = BigInt(Math.floor(Number(input.maxUnitPrice)));
        const deadlineMs = Number(input.deadlineMs);
        const pending = [...ws.pages.values()].flatMap((p) => p.chunks).filter((c) => !ws.vectors.has(c.id));
        if (pending.length === 0 && ws.queryVec) return JSON.stringify({ note: 'nothing new to embed', ranked: ws.ranked.slice(0, 8).map((r) => ({ id: r.id, score: +r.score.toFixed(3), url: r.url, text: r.text.slice(0, 200) })) });
        const batches: Chunk[][] = [];
        for (let i = 0; i < pending.length; i += 63) batches.push(pending.slice(i, i + 63));
        let spent = 0n;
        let providers: string[] = [];
        for (const [bi, batch] of batches.entries()) {
          const texts = batch.map((c) => c.text);
          if (bi === 0) texts.push(query);
          const purchase = await market.buyEmbeddings(texts, { maxUnitPrice, ceiling: maxUnitPrice, deadlineMs });
          const vecs = purchase.result.output.embeddings ?? [];
          batch.forEach((c, i) => ws.vectors.set(c.id, vecs[i] ?? []));
          if (bi === 0) ws.queryVec = vecs[batch.length];
          spent += purchase.amount;
          providers.push(purchase.result.providerName);
        }
        const all = [...ws.pages.values()].flatMap((p) => p.chunks);
        ws.ranked = rankChunks(ws.queryVec ?? [], all, all.map((c) => ws.vectors.get(c.id) ?? []), 8);
        return JSON.stringify({
          embedded: pending.length,
          batches: batches.length,
          paidAusd: formatUnits(spent, 6, 4),
          providers: [...new Set(providers)],
          ranked: ws.ranked.map((r) => ({ id: r.id, score: +r.score.toFixed(3), url: r.url, text: r.text.slice(0, 200) })),
        });
      }
      case 'buy_generation': {
        const rail = String(input.rail) as 'x402' | 'stream';
        const maxTokens = Number(input.maxTokens);
        const maxUnitPrice = BigInt(Math.floor(Number(input.maxUnitPrice)));
        const stopAfter = input.stopAfterTokens == null ? undefined : Number(input.stopAfterTokens);
        const question = task.question ?? task.indexUrl ?? '';
        const prompt = ws.ranked.length ? buildAnswerPrompt(question, ws.ranked) : `Answer concisely: ${question}`;
        if (rail === 'stream') {
          const streamOpts: StreamOptions = { maxTokens, maxDropsPerToken: maxUnitPrice, ceiling: maxUnitPrice, stopAfterTokens: stopAfter ?? task.stopAfterTokens, model: deps.genModel };
          const out = await streamGeneration({ exchangeUrl: deps.exchangeUrl, wallet: deps.wallet, issuer: deps.issuer, persona, log, budget: deps.xrp }, prompt, streamOpts);
          ws.lastStream = out;
          ws.answer = out.text;
          return JSON.stringify({ rail, text: out.text, tokens: out.tokens, dropsPaid: out.dropsPaid.toString(), xrpPaid: formatUnits(out.dropsPaid, 6), claimTx: out.claimTx, stoppedEarly: out.stopped, provider: out.providerName });
        }
        const purchase = await market.buyGeneration(prompt, maxTokens, { maxUnitPrice, ceiling: maxUnitPrice, deadlineMs: Math.max(persona.deadlineMs, 20_000), model: deps.genModel });
        ws.answer = purchase.result.output.text ?? '';
        return JSON.stringify({ rail, text: ws.answer, tokens: purchase.result.output.tokens, paidAusd: formatUnits(purchase.amount, 6, 4), txHash: purchase.result.receipt?.txHash, provider: purchase.result.providerName });
      }
      case 'budget': {
        const b = market.budget();
        return JSON.stringify({ ausd: { spent: formatUnits(b.spent, 6, 4), remaining: formatUnits(b.remaining, 6, 4) }, xrp: { authorized: formatUnits(deps.xrp.authorized, 6), remaining: formatUnits(deps.xrp.remaining, 6) } });
      }
      case 'finish': {
        finished = String(input.answer);
        return 'done';
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  };

  while (iterations < 24 && finished === undefined) {
    iterations++;
    const response = await client.messages.create({
      model: deps.model,
      max_tokens: 8000,
      system,
      tools: TOOLS,
      messages,
      output_config: { effort: deps.effort },
    });
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) log.thought(block.text.trim().split('\n')[0].slice(0, 200));
    }
    if (response.stop_reason === 'refusal') {
      log.error(`model refused (${response.stop_details?.category ?? 'unknown'})`);
      break;
    }
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n');
      if (!finished && text.trim()) finished = text.trim();
      break;
    }
    if (response.stop_reason === 'max_tokens') {
      log.error('tool input truncated (max_tokens)');
      break;
    }
    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      log.action(`${tu.name}(${summarizeInput(input)})`);
      try {
        const out = await run(tu.name, input);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const detail = (e as { detail?: unknown }).detail;
        log.error(`${tu.name} failed: ${msg}`);
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ error: msg, ...(detail && typeof detail === 'object' ? { detail } : {}) }) });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  const answer = finished ?? ws.answer;
  return { answer, sources: [...sources], iterations, stream: ws.lastStream };
}

function summarizeInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.slice(0, 60)) : JSON.stringify(v)}`)
    .join(', ');
}
