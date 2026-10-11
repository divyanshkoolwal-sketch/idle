/** Embed 4 texts (consistent dims) and generate 32 tokens (prints tokens/sec). */
import { loadEnv, REPO_ROOT } from '@idle/shared';
import { banner, ok, info, fail, assert } from './_lib';

loadEnv(REPO_ROOT);
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const EMBED = process.env.EMBED_MODEL ?? 'nomic-embed-text';
const GEN = process.env.GEN_MODEL ?? 'llama3.2:3b';

banner(`smoke: Ollama @ ${OLLAMA}`);
const texts = ['GPUs are sold out.', 'Agents need compute per job.', 'Data centers have spare minutes.', 'Idle is a spot market.'];
const t0 = Date.now();
const er = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', body: JSON.stringify({ model: EMBED, input: texts }) });
if (!er.ok) fail(`embed failed: ${er.status} ${await er.text()}`);
const ej = (await er.json()) as { embeddings: number[][] };
assert(Array.isArray(ej.embeddings) && ej.embeddings.length === 4, 'expected 4 embeddings');
const dims = new Set(ej.embeddings.map((e) => e.length));
assert(dims.size === 1, `inconsistent dims ${[...dims]}`);
ok(`embed ${EMBED}: 4 texts → dim ${ej.embeddings[0].length} in ${Date.now() - t0} ms`);

const gr = await fetch(`${OLLAMA}/api/generate`, {
  method: 'POST',
  body: JSON.stringify({ model: GEN, prompt: 'Name three open-source language models and one fact about each.', stream: true, options: { num_predict: 32, temperature: 0.2, seed: 7 } }),
});
if (!gr.ok || !gr.body) fail(`generate failed: ${gr.status} ${await gr.text()}`);
const reader = gr.body.getReader();
const dec = new TextDecoder();
let buf = '';
let text = '';
let final: { eval_count?: number; eval_duration?: number } = {};
let streamed = 0;
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const j = JSON.parse(line);
    if (j.response) {
      text += j.response;
      streamed++;
    }
    if (j.done) final = j;
  }
}
const tps = final.eval_count && final.eval_duration ? (final.eval_count / (final.eval_duration / 1e9)).toFixed(1) : '?';
info(`"${text.replace(/\s+/g, ' ').slice(0, 100)}…"`);
ok(`generate ${GEN}: ${final.eval_count ?? streamed} tokens, ${tps} tok/s (streamed ${streamed} chunks)`);
