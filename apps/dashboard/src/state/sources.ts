import { DashboardEvent as DashboardEventSchema, type DashboardEvent } from '@shared/protocol';

const warned = new Set<string>();
export function parseFrame(raw: unknown): DashboardEvent | null {
  const r = DashboardEventSchema.safeParse(raw);
  if (r.success) return r.data;
  const t = (raw as { type?: string })?.type ?? '?';
  if (!warned.has(t)) {
    warned.add(t);
    console.warn(`[idle] frame "${t}" did not match the protocol; applying raw`, r.error.issues.slice(0, 3));
  }
  return raw && typeof raw === 'object' && 'type' in (raw as object) && 'ts' in (raw as object) ? (raw as DashboardEvent) : null;
}

export function liveUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/v1/events`;
}

/** WebSocket with exponential backoff. Returns a disposer. */
export function connectLive(onEvent: (ev: DashboardEvent) => void, onStatus: (s: 'connecting' | 'open' | 'closed') => void): () => void {
  let ws: WebSocket | null = null;
  let disposed = false;
  let delay = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    if (disposed) return;
    onStatus('connecting');
    ws = new WebSocket(liveUrl());
    ws.onopen = () => {
      delay = 500;
      onStatus('open');
    };
    ws.onmessage = (m) => {
      try {
        const ev = parseFrame(JSON.parse(String(m.data)));
        if (ev) onEvent(ev);
      } catch (e) {
        console.warn('[idle] bad frame', e);
      }
    };
    ws.onclose = () => {
      onStatus('closed');
      if (!disposed) {
        timer = setTimeout(open, delay);
        delay = Math.min(delay * 2, 8000);
      }
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

export function parseJsonl(text: string): DashboardEvent[] {
  const out: DashboardEvent[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = parseFrame(JSON.parse(t));
      if (ev) out.push(ev);
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export interface ReplayStatus {
  playing: boolean;
  speed: number;
  index: number;
  total: number;
  loop: boolean;
}

/**
 * Plays frames with their original relative timing (gaps capped at 4 s) at a speed multiplier.
 * Scheduling is anchored to wall-clock time, and late frames are dispatched in a batch, so the
 * replay never drifts behind its own clock when rendering is slower than the frame gaps.
 */
export class ReplayPlayer {
  private idx = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private _playing = false;
  private vts: number[] = []; // virtual timeline (ms) with capped gaps
  private anchorWall = 0;
  private anchorV = 0;
  speed = 1;
  loop = true;
  constructor(
    private frames: DashboardEvent[],
    private onEvent: (ev: DashboardEvent) => void,
    private onStatus: (s: ReplayStatus) => void,
  ) {
    let v = 0;
    this.vts = frames.map((f, i) => {
      if (i > 0) v += Math.min(Math.max(f.ts - frames[i - 1].ts, 0), 4000);
      return v;
    });
  }

  status(): ReplayStatus {
    return { playing: this._playing, speed: this.speed, index: this.idx, total: this.frames.length, loop: this.loop };
  }

  private anchor() {
    this.anchorWall = performance.now();
    this.anchorV = this.vts[Math.min(this.idx, this.vts.length - 1)] ?? 0;
  }

  play() {
    if (this._playing) return;
    this._playing = true;
    this.anchor();
    this.onStatus(this.status());
    this.step();
  }

  pause() {
    this._playing = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.onStatus(this.status());
  }

  setSpeed(x: number) {
    this.speed = x;
    this.anchor();
    this.onStatus(this.status());
  }

  restart() {
    this.pause();
    this.idx = 0;
    this.play();
  }

  dispose() {
    this.pause();
  }

  private due(i: number): number {
    return this.anchorWall + (this.vts[i] - this.anchorV) / this.speed;
  }

  private step = () => {
    if (!this._playing) return;
    if (this.idx >= this.frames.length) {
      if (this.loop) {
        this.idx = 0;
        this.timer = setTimeout(() => {
          this.anchor();
          this.step();
        }, 2500 / this.speed);
      } else {
        this.pause();
      }
      return;
    }
    const now = performance.now();
    let n = 0;
    while (this.idx < this.frames.length && this.due(this.idx) <= now && n < 200) {
      this.onEvent(this.frames[this.idx]);
      this.idx += 1;
      n += 1;
    }
    if (n > 0) this.onStatus(this.status());
    const wait = this.idx < this.frames.length ? Math.max(0, this.due(this.idx) - performance.now()) : 0;
    this.timer = setTimeout(this.step, wait);
  };
}
