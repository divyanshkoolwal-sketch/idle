import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GOLDEN_TEXTS } from '@idle/shared';

/**
 * Embedding device for the exchange's reference + spot checks. Default CPU (`num_gpu: 0`): on some Macs
 * Ollama's Metal path returns non-discriminating/non-deterministic embeddings, and verification must be exact.
 * Set EMBED_DEVICE=gpu to use the default device.
 */
export const EMBED_DEVICE: 'cpu' | 'gpu' = (process.env.EMBED_DEVICE ?? 'cpu').toLowerCase() === 'gpu' ? 'gpu' : 'cpu';

export async function ollamaEmbed(ollamaUrl: string, model: string, input: string[], timeoutMs = 60_000): Promise<number[][]> {
  const res = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input, ...(EMBED_DEVICE === 'cpu' ? { options: { num_gpu: 0 } } : {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ollama embed ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { embeddings: number[][] };
  if (!Array.isArray(j.embeddings) || j.embeddings.length !== input.length) throw new Error('ollama embed returned wrong shape');
  return j.embeddings;
}

export interface Reference {
  model: string;
  texts: readonly string[];
  vectors: number[][];
  embed: (texts: string[]) => Promise<number[][]>;
}

/** Golden-set reference vectors from the exchange's own Ollama, cached on disk per model. */
export async function loadReference(opts: { ollamaUrl: string; model: string; dataDir: string }): Promise<Reference> {
  const file = path.join(opts.dataDir, `golden-${EMBED_DEVICE}.json`);
  const embed = (texts: string[]) => ollamaEmbed(opts.ollamaUrl, opts.model, texts);
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as { model: string; texts: string[]; vectors: number[][] };
      if (cached.model === opts.model && cached.texts.length === GOLDEN_TEXTS.length && cached.texts.every((t, i) => t === GOLDEN_TEXTS[i])) {
        return { model: opts.model, texts: GOLDEN_TEXTS, vectors: cached.vectors, embed };
      }
    } catch {
      /* recompute */
    }
  }
  const t0 = Date.now();
  const vectors = await embed([...GOLDEN_TEXTS]);
  mkdirSync(opts.dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ model: opts.model, texts: GOLDEN_TEXTS, vectors }));
  console.log(`[reference] embedded ${GOLDEN_TEXTS.length} golden texts with ${opts.model} in ${Date.now() - t0} ms (dim ${vectors[0]?.length})`);
  return { model: opts.model, texts: GOLDEN_TEXTS, vectors, embed };
}
