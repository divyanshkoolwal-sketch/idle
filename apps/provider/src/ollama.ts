export type OllamaErrorCode = 'TIMEOUT' | 'HTTP' | 'NETWORK' | 'PARSE' | 'ABORTED';
export class OllamaError extends Error {
  constructor(message: string, public readonly code: OllamaErrorCode, public readonly status?: number) {
    super(message);
    this.name = 'OllamaError';
  }
}

export interface GenerateOptions {
  maxTokens: number;
  temperature?: number;
  seed?: number;
  /** Ollama `num_gpu`; 0 forces CPU decode (used when the Metal path is found to be broken). */
  numGpu?: number;
}
const genOptions = (o: GenerateOptions) => ({
  num_predict: o.maxTokens,
  temperature: o.temperature ?? 0,
  ...(o.seed !== undefined ? { seed: o.seed } : {}),
  ...(o.numGpu !== undefined ? { num_gpu: o.numGpu } : {}),
});
export interface GenerateResult {
  text: string;
  tokens: number;
  evalCount: number;
  evalDurationNs: number;
  ms: number;
}
export interface StreamStats {
  evalCount: number;
  evalDurationNs: number;
  doneReason?: string;
}

function wrap(e: unknown, what: string): OllamaError {
  if (e instanceof OllamaError) return e;
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err.name === 'TimeoutError') return new OllamaError(`${what}: timed out`, 'TIMEOUT');
  if (err.name === 'AbortError') return new OllamaError(`${what}: aborted`, 'ABORTED');
  return new OllamaError(`${what}: ${err.cause?.code ?? err.message ?? String(e)}`, 'NETWORK');
}

/** Thin Ollama HTTP client. All methods throw OllamaError with a code. */
export class Ollama {
  constructor(public readonly baseUrl: string) {}

  private async post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, signal });
    } catch (e) {
      throw wrap(e, `POST ${path}`);
    }
    if (!res.ok) throw new OllamaError(`POST ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`, 'HTTP', res.status);
    return res;
  }

  async tags(timeoutMs = 5000): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new OllamaError(`GET /api/tags → ${res.status}`, 'HTTP', res.status);
      const j = (await res.json()) as { models?: { name: string }[] };
      return (j.models ?? []).map((m) => m.name);
    } catch (e) {
      throw wrap(e, 'GET /api/tags');
    }
  }

  async embed(model: string, input: string[], opts: { numGpu?: number; timeoutMs?: number } = {}): Promise<{ embeddings: number[][]; ms: number }> {
    const t0 = Date.now();
    const body = { model, input, ...(opts.numGpu !== undefined ? { options: { num_gpu: opts.numGpu } } : {}) };
    const res = await this.post('/api/embed', body, AbortSignal.timeout(opts.timeoutMs ?? 120_000));
    const j = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(j.embeddings) || j.embeddings.length !== input.length) {
      throw new OllamaError(`embed returned ${j.embeddings?.length ?? 'no'} vectors for ${input.length} inputs`, 'PARSE');
    }
    return { embeddings: j.embeddings, ms: Date.now() - t0 };
  }

  async generate(model: string, prompt: string, opts: GenerateOptions, timeoutMs = 180_000): Promise<GenerateResult> {
    const t0 = Date.now();
    const res = await this.post(
      '/api/generate',
      { model, prompt, stream: false, options: genOptions(opts) },
      AbortSignal.timeout(timeoutMs),
    );
    const j = (await res.json()) as { response?: string; eval_count?: number; eval_duration?: number };
    if (typeof j.response !== 'string') throw new OllamaError('generate returned no response', 'PARSE');
    return { text: j.response, tokens: j.eval_count ?? 0, evalCount: j.eval_count ?? 0, evalDurationNs: j.eval_duration ?? 0, ms: Date.now() - t0 };
  }

  /** Streams tokens from NDJSON. Yields {token,index}; the return value carries the final stats. */
  async *generateStream(model: string, prompt: string, opts: GenerateOptions, signal?: AbortSignal, idleTimeoutMs = 60_000): AsyncGenerator<{ token: string; index: number }, StreamStats, void> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let idle = setTimeout(() => controller.abort(), idleTimeoutMs);
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), idleTimeoutMs);
    };
    try {
      const res = await this.post(
        '/api/generate',
        { model, prompt, stream: true, options: genOptions(opts) },
        controller.signal,
      );
      if (!res.body) throw new OllamaError('generate stream has no body', 'PARSE');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let index = 0;
      const stats: StreamStats = { evalCount: 0, evalDurationNs: 0 };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bump();
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let j: { response?: string; done?: boolean; eval_count?: number; eval_duration?: number; done_reason?: string; error?: string };
            try {
              j = JSON.parse(line);
            } catch {
              throw new OllamaError(`bad NDJSON line: ${line.slice(0, 80)}`, 'PARSE');
            }
            if (j.error) throw new OllamaError(j.error, 'HTTP');
            if (j.response) yield { token: j.response, index: index++ };
            if (j.done) {
              stats.evalCount = j.eval_count ?? index;
              stats.evalDurationNs = j.eval_duration ?? 0;
              stats.doneReason = j.done_reason;
            }
          }
        }
      } catch (e) {
        if (signal?.aborted) throw new OllamaError('generate stream aborted', 'ABORTED');
        throw wrap(e, 'generate stream');
      } finally {
        reader.cancel().catch(() => undefined);
      }
      if (!stats.evalCount) stats.evalCount = index;
      return stats;
    } finally {
      clearTimeout(idle);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
