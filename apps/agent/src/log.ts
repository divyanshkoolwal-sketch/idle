import type { AgentLog } from '@idle/shared';

/** Human-readable agent log: console + POST /v1/agents/:id/log (fire-and-forget) for the dashboard console. */
export class AgentLogger {
  private queue: Array<Promise<unknown>> = [];
  constructor(
    readonly agentId: string,
    readonly persona: string,
    private exchangeUrl: string,
    private quiet = false,
  ) {}

  log(kind: AgentLog['kind'], text: string, meta?: Record<string, unknown>): void {
    const ts = Date.now();
    if (!this.quiet) {
      const tag = { thought: '💭', action: '▶', spend: '$', result: '✔', error: '✘' }[kind];
      console.log(`[${this.persona}] ${tag} ${text}`);
    }
    const p = fetch(`${this.exchangeUrl}/v1/agents/${encodeURIComponent(this.agentId)}/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: this.persona, kind, text, ts, meta }),
    }).catch(() => undefined);
    this.queue.push(p);
    if (this.queue.length > 50) this.queue.splice(0, this.queue.length - 50);
  }
  thought = (t: string, m?: Record<string, unknown>) => this.log('thought', t, m);
  action = (t: string, m?: Record<string, unknown>) => this.log('action', t, m);
  spend = (t: string, m?: Record<string, unknown>) => this.log('spend', t, m);
  result = (t: string, m?: Record<string, unknown>) => this.log('result', t, m);
  error = (t: string, m?: Record<string, unknown>) => this.log('error', t, m);
  async flush(): Promise<void> {
    await Promise.allSettled(this.queue);
  }
}
