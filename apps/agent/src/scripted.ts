/**
 * Scripted buyer: the same pipeline with fixed decisions (no Claude). Used for acceptance runs,
 * `--jobs N` load, and as the fallback when ANTHROPIC_API_KEY is absent.
 */
import { formatUnits } from '@idle/shared';
import type { AgentDeps, AgentOutcome } from './claude';
import { chunkMarkdown, rankChunks, buildAnswerPrompt, type Chunk } from './research';
import { webSearch, scrape } from './tools/context';
import { streamGeneration } from './stream';

const SAMPLE = [
  'The spot price of compute follows the load on the market, not the calendar.',
  'Sealed-bid second-price auctions make honest bidding the dominant strategy.',
  'A laptop with a free GPU minute is a data center nobody can rent.',
  'Payment channels settle thousands of micro-payments with two ledger transactions.',
  'Credentials on the ledger let a buyer verify a seller without trusting the exchange.',
  'Embeddings turn sentences into points; nearby points mean similar meaning.',
  'Verification by re-execution catches a cheater who returns random vectors.',
  'Agents need compute per job, right now, without accounts or credit cards.',
  'Base Sepolia gas is cheap enough that a faucet drip pays for thousands of settlements.',
  'The fog over the bay burns off by noon most summer mornings in Berkeley.',
  'An exchange clears an auction in a quarter of a second.',
  'Prices rise when the market is busy and fall when it is idle.',
];

export async function runScripted(deps: AgentDeps, task: { question?: string; indexUrl?: string; jobs?: number; stopAfterTokens?: number }): Promise<AgentOutcome> {
  const { market, log, persona } = deps;
  if (task.jobs) {
    log.thought(`buying ${task.jobs} embedding jobs on the x402 rail`);
    for (let i = 0; i < task.jobs; i++) {
      const n = 8 + Math.floor(Math.random() * 24);
      const texts = Array.from({ length: n }, (_, k) => `${SAMPLE[(i + k) % SAMPLE.length]} (${i}-${k})`);
      try {
        await market.buyEmbeddings(texts);
      } catch (e) {
        log.error(`job ${i + 1} failed: ${(e as Error).message}`);
      }
    }
    return { answer: undefined, sources: [], iterations: task.jobs };
  }

  const pages: Array<{ url: string; title: string; chunks: Chunk[] }> = [];
  let nextId = 0;
  const sources: string[] = [];
  if (task.indexUrl) {
    log.thought(`indexing ${task.indexUrl}`);
    const page = await scrape(task.indexUrl, 40_000);
    const title = page.markdown.match(/^#\s+(.+)$/m)?.[1] ?? task.indexUrl;
    const chunks = chunkMarkdown(task.indexUrl, title, page.markdown, 800, nextId);
    nextId += chunks.length;
    pages.push({ url: task.indexUrl, title, chunks });
    sources.push(task.indexUrl);
    const links = [...new Set(page.markdown.match(/https?:\/\/[^\s)\]"']+/g) ?? [])].filter((l) => l.startsWith(new URL(task.indexUrl!).origin)).slice(0, 5);
    for (const l of links) {
      try {
        const p = await scrape(l, 20_000);
        const t = p.markdown.match(/^#\s+(.+)$/m)?.[1] ?? l;
        const c = chunkMarkdown(l, t, p.markdown, 800, nextId);
        nextId += c.length;
        pages.push({ url: l, title: t, chunks: c });
        sources.push(l);
      } catch (e) {
        log.error(`scrape ${l} failed: ${(e as Error).message}`);
      }
    }
  } else if (task.question) {
    log.thought(`searching: ${task.question}`);
    const hits = await webSearch(task.question, 8);
    log.result(`${hits.length} results; scraping the top 4`);
    for (const h of hits.slice(0, 4)) {
      try {
        const p = await scrape(h.url);
        const chunks = chunkMarkdown(h.url, h.title, p.markdown, 800, nextId);
        nextId += chunks.length;
        pages.push({ url: h.url, title: h.title, chunks });
        sources.push(h.url);
      } catch (e) {
        log.error(`scrape ${h.url} failed: ${(e as Error).message}`);
      }
    }
  }
  const all = pages.flatMap((p) => p.chunks);
  log.thought(`${all.length} chunks from ${pages.length} pages; buying embeddings`);
  const vectors: number[][] = [];
  let queryVec: number[] = [];
  for (let i = 0; i < all.length; i += 63) {
    const batch = all.slice(i, i + 63);
    const texts = batch.map((c) => c.text);
    if (i === 0 && task.question) texts.push(task.question);
    const purchase = await market.buyEmbeddings(texts);
    const vecs = purchase.result.output.embeddings ?? [];
    vectors.push(...vecs.slice(0, batch.length));
    if (i === 0 && task.question) queryVec = vecs[batch.length] ?? [];
  }
  if (task.indexUrl) {
    const b = market.budget();
    const summary = `Indexed ${all.length} chunks from ${pages.length} pages of ${task.indexUrl}; spent ${formatUnits(b.spent, 6, 4)} AUSD.`;
    log.result(summary);
    return { answer: summary, sources, iterations: pages.length };
  }
  const ranked = rankChunks(queryVec, all, vectors, 8);
  const prompt = buildAnswerPrompt(task.question!, ranked);
  if (persona.finalAnswerRail === 'stream') {
    const out = await streamGeneration({ exchangeUrl: deps.exchangeUrl, wallet: deps.wallet, issuer: deps.issuer, persona, log, budget: deps.xrp }, prompt, {
      maxTokens: 300,
      stopAfterTokens: task.stopAfterTokens ?? 150,
      model: deps.genModel,
      onToken: (t) => process.stdout.write(t),
    });
    process.stdout.write('\n');
    return { answer: out.text, sources, iterations: 1, stream: out };
  }
  const purchase = await market.buyGeneration(prompt, 256, { deadlineMs: 30_000, model: deps.genModel });
  return { answer: purchase.result.output.text, sources, iterations: 1 };
}
