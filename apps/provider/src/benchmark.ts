import type { Ollama } from './ollama';
import type { Benchmark } from './types';
import type { Logger } from './log';

const SUBJECTS = ['A payment channel', 'The GPU shortage', 'An embedding model', 'Berkeley fog', 'A sealed-bid auction', 'The data center', 'A stablecoin settlement', 'The idle laptop'];
const VERBS = ['settles', 'prices', 'maps', 'rolls over', 'rewards', 'rents out', 'verifies', 'streams'];
const OBJECTS = ['spare minutes nobody sells by the hour.', 'inference jobs in a quarter of a second.', 'sentences into a high-dimensional space.', 'the bay before noon.', 'honest bids over clever ones.', 'tokens one claim at a time.', 'work by re-running a sample.', 'gas that somebody still has to pay.'];

/** 64 deterministic sample texts (same on every laptop, so benchmarks are comparable). */
export function sampleTexts(n = 64): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${SUBJECTS[i % 8]} ${VERBS[(i * 3) % 8]} ${OBJECTS[(i * 5) % 8]} (#${i})`);
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const DEFAULT_BENCHMARK: Benchmark = { embedTps: 50, genTps: 20, embedMs: 1280, genMs: 6400 };

/**
 * Known-answer canary for the decode path. Ollama 0.34's Metal runtime produces degenerate text on some
 * Apple Silicon machines while CPU decode is correct; pick the first path whose output is sane.
 * Returns the `num_gpu` to use for generation (undefined = Ollama default, 0 = CPU), or throws if neither works.
 */
export async function probeGeneration(ollama: Ollama, model: string, log: Logger, pref: 'auto' | 'gpu' | 'cpu' = 'auto'): Promise<number | undefined> {
  const prompt = 'Reply with exactly the word OK and nothing else.';
  const sane = (text: string) => /\bOK\b/i.test(text) && !/[^\x00-\x7f]/.test(text.slice(0, 8));
  const candidates: Array<number | undefined> = pref === 'gpu' ? [undefined] : pref === 'cpu' ? [0] : [undefined, 0];
  for (const numGpu of candidates) {
    try {
      // probe with an explicit all-layers GPU load so an already-loaded CPU runner can't mask a broken Metal path
      const r = await ollama.generate(model, prompt, { maxTokens: 8, temperature: 0, numGpu: numGpu ?? 99 });
      const ok = sane(r.text);
      log.info(`decode probe ${numGpu === 0 ? 'cpu' : 'gpu'}: ${ok ? 'ok' : 'DEGENERATE'} ${JSON.stringify(r.text.slice(0, 40))}`);
      if (ok) {
        if (numGpu === 0) log.warn('GPU decode is broken on this machine (Ollama Metal bug); generating on CPU');
        return numGpu;
      }
    } catch (e) {
      log.warn(`decode probe ${numGpu === 0 ? 'cpu' : 'gpu'} failed: ${(e as Error).message}`);
    }
  }
  throw new Error(`generation with ${model} is degenerate on both GPU and CPU — try another GEN_MODEL (e.g. qwen2.5:1.5b)`);
}

/**
 * Embed 64 texts ×3 → texts/sec (median). Generate 128 tokens ×2 → tokens/sec from eval_count/eval_duration.
 * Each model is warmed once before timing so model load time doesn't pollute the numbers.
 */
const PROBE_TEXTS = ['A cat sleeps on the sofa.', 'The kitten naps on the couch.', 'Quarterly GDP figures were revised upward.'];
const cos = (a: number[], b: number[]) => {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

/**
 * Same idea for embeddings: a sane model scores the paraphrase pair well above the unrelated pair.
 * Returns the `num_gpu` to use for embeddings (undefined = default, 0 = CPU).
 */
export async function probeEmbedding(ollama: Ollama, model: string, log: Logger, pref: 'auto' | 'gpu' | 'cpu' = 'auto'): Promise<number | undefined> {
  const candidates: Array<number | undefined> = pref === 'gpu' ? [undefined] : pref === 'cpu' ? [0] : [undefined, 0];
  for (const numGpu of candidates) {
    try {
      const { embeddings: e } = await ollama.embed(model, PROBE_TEXTS, { numGpu: numGpu ?? 99 });
      const similar = cos(e[0], e[1]);
      const unrelated = cos(e[0], e[2]);
      const ok = similar - unrelated > 0.2 && similar > 0.6;
      log.info(`embed probe ${numGpu === 0 ? 'cpu' : 'gpu'}: ${ok ? 'ok' : 'DEGENERATE'} (paraphrase ${similar.toFixed(3)} vs unrelated ${unrelated.toFixed(3)})`);
      if (ok) {
        if (numGpu === 0) log.warn('GPU embeddings are broken on this machine (Ollama Metal bug); embedding on CPU');
        return numGpu;
      }
    } catch (e) {
      log.warn(`embed probe ${numGpu === 0 ? 'cpu' : 'gpu'} failed: ${(e as Error).message}`);
    }
  }
  throw new Error(`embeddings with ${model} are degenerate on both GPU and CPU`);
}

export async function runBenchmark(ollama: Ollama, models: { embedModel: string; genModel: string; genNumGpu?: number; embedNumGpu?: number }, log: Logger): Promise<Benchmark & { embedDim: number }> {
  const texts = sampleTexts(64);
  log.info(`benchmark: warming ${models.embedModel} and ${models.genModel} …`);
  const warm = await ollama.embed(models.embedModel, texts.slice(0, 4), { numGpu: models.embedNumGpu });
  const embedDim = warm.embeddings[0]?.length ?? 0;
  await ollama.generate(models.genModel, 'Say hello in five words.', { maxTokens: 8, numGpu: models.genNumGpu });

  const embedRuns: number[] = [];
  for (let i = 0; i < 3; i++) {
    const { ms } = await ollama.embed(models.embedModel, texts, { numGpu: models.embedNumGpu });
    embedRuns.push(ms);
  }
  const embedMs = median(embedRuns);
  const embedTps = texts.length / (embedMs / 1000);

  const genRuns: { ms: number; tps: number }[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await ollama.generate(models.genModel, 'Write a short paragraph about why spot markets exist for compute.', { maxTokens: 128, numGpu: models.genNumGpu });
    const tps = r.evalDurationNs > 0 ? r.evalCount / (r.evalDurationNs / 1e9) : r.tokens / (r.ms / 1000);
    genRuns.push({ ms: r.ms, tps });
  }
  const genMs = median(genRuns.map((g) => g.ms));
  const genTps = median(genRuns.map((g) => g.tps));

  const result = { embedTps: round(embedTps), genTps: round(genTps), embedMs: Math.round(embedMs), genMs: Math.round(genMs), embedDim };
  log.info(`benchmark: embed ${result.embedTps} texts/s (64 texts in ${result.embedMs} ms, dim ${embedDim}${models.embedNumGpu === 0 ? ', cpu' : ''}) · generate ${result.genTps} tok/s (128 tokens in ${result.genMs} ms${models.genNumGpu === 0 ? ', cpu' : ''})`);
  return result;
}

const round = (x: number) => Math.round(x * 10) / 10;
