import { cosine } from '@idle/shared';

export interface Chunk {
  id: number;
  url: string;
  title: string;
  text: string;
}

/** Split markdown into ~800-character pieces on paragraph boundaries. */
export function chunkMarkdown(url: string, title: string, markdown: string, target = 800, startId = 0): Chunk[] {
  const paras = markdown
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 40 && !/^[|#\-=*_]+$/.test(p));
  const chunks: Chunk[] = [];
  let buf = '';
  let id = startId;
  for (const p of paras) {
    if ((buf + ' ' + p).length > target && buf) {
      chunks.push({ id: id++, url, title, text: buf.trim() });
      buf = p;
    } else {
      buf = buf ? buf + ' ' + p : p;
    }
    if (buf.length > target * 1.6) {
      chunks.push({ id: id++, url, title, text: buf.slice(0, target * 1.6).trim() });
      buf = buf.slice(target * 1.6);
    }
  }
  if (buf.trim()) chunks.push({ id: id++, url, title, text: buf.trim() });
  return chunks;
}

export function rankChunks(query: number[], chunks: Chunk[], vectors: number[][], k = 8): Array<Chunk & { score: number }> {
  return chunks
    .map((c, i) => ({ ...c, score: cosine(query, vectors[i] ?? []) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** A cited-answer prompt for the generation model. */
export function buildAnswerPrompt(question: string, top: Array<Chunk & { score: number }>): string {
  const sources = [...new Map(top.map((c) => [c.url, c.title])).entries()];
  const ctx = top.map((c) => `[${sources.findIndex(([u]) => u === c.url) + 1}] ${c.text}`).join('\n\n');
  const list = sources.map(([u, t], i) => `[${i + 1}] ${t} — ${u}`).join('\n');
  return `You are a precise research assistant. Answer the question using only the sources below. Cite with [n] after each claim. Be concise (under 180 words). End with a line "Sources:" followed by the numbered list.\n\nSources:\n${list}\n\nExcerpts:\n${ctx}\n\nQuestion: ${question}\n\nAnswer:`;
}
