import ContextDev from 'context.dev';

let client: ContextDev | null = null;
function ctx(): ContextDev {
  if (!process.env.CONTEXT_DEV_API_KEY) throw new Error('CONTEXT_DEV_API_KEY missing');
  if (!client) client = new ContextDev({ apiKey: process.env.CONTEXT_DEV_API_KEY, timeout: 45_000 });
  return client;
}

export interface SearchHit {
  title: string;
  url: string;
  description: string;
  relevance: 'high' | 'medium' | 'low';
}

/** Context.dev web search. */
export async function webSearch(query: string, numResults = 8): Promise<SearchHit[]> {
  const res = await ctx().web.search({ query, numResults: Math.max(10, Math.min(numResults, 20)) });
  return res.results.slice(0, numResults).map((r) => ({ title: r.title, url: r.url, description: r.description, relevance: r.relevance }));
}

/** Context.dev scrape to markdown, main content only. */
export async function scrape(url: string, maxChars = 12_000): Promise<{ url: string; markdown: string; truncated: boolean }> {
  const page = await ctx().web.scrape({ url, formats: { markdown: true }, sharedParams: { mainContentOnly: true } });
  if (!page.markdown.success || !page.markdown.data) {
    throw new Error(`scrape failed for ${url}: ${page.markdown.error_code ?? ''} ${page.markdown.message ?? ''}`.trim());
  }
  const md = page.markdown.data;
  return { url, markdown: md.slice(0, maxChars), truncated: md.length > maxChars };
}
