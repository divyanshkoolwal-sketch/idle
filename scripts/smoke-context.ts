/** Context.dev: search, then scrape the top result to markdown. */
import ContextDev from 'context.dev';
import { loadEnv, REPO_ROOT } from '@idle/shared';
import { banner, ok, info, fail } from './_lib';

loadEnv(REPO_ROOT);
banner('smoke: Context.dev');
if (!process.env.CONTEXT_DEV_API_KEY) {
  console.log('  CONTEXT_DEV_API_KEY is not set. Add it to .env (get one at https://context.dev) and re-run.');
  process.exit(2);
}
const client = new ContextDev({ apiKey: process.env.CONTEXT_DEV_API_KEY });
const q = 'Apple Silicon local LLM inference benchmarks';
const t0 = Date.now();
const s = await client.web.search({ query: q, numResults: 10 });
if (!s.results?.length) fail(`search returned no results (request_id ${s.request_id})`);
ok(`search "${q}": ${s.results.length} results in ${Date.now() - t0} ms`);
for (const r of s.results.slice(0, 3)) info(`${r.relevance.padEnd(6)} ${r.title.slice(0, 60)}  ${r.url}`);
const top = s.results[0];
const t1 = Date.now();
const page = await client.web.scrape({ url: top.url, formats: { markdown: true }, sharedParams: { mainContentOnly: true } });
if (!page.markdown.success || !page.markdown.data) fail(`scrape failed: ${page.markdown.error_code} ${page.markdown.message}`);
ok(`scrape ${top.url}: ${page.markdown.data.length} chars of markdown in ${Date.now() - t1} ms`);
info(page.markdown.data.replace(/\s+/g, ' ').slice(0, 200) + '…');
