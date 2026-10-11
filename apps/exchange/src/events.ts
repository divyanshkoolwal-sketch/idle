import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type { DashboardEvent } from '@idle/shared';

type Frames = { [K in DashboardEvent['type']]: Omit<Extract<DashboardEvent, { type: K }>, 'ts'> };
export type EventInput = Frames[keyof Frames];
export type SnapshotInput = Omit<Extract<DashboardEvent, { type: 'snapshot' }>, 'ts' | 'type'>;

/** Typed fan-out of dashboard events over `WS /v1/events`, with optional JSONL recording. */
export class EventBus {
  private sockets = new Set<WebSocket>();
  private listeners = new Set<(e: DashboardEvent) => void>();
  private recorder?: WriteStream;
  private snapshotFn: () => SnapshotInput | Promise<SnapshotInput> = () => {
    throw new Error('snapshot not wired');
  };

  constructor(recordDir?: string) {
    if (recordDir) {
      mkdirSync(recordDir, { recursive: true });
      const file = path.join(recordDir, `events-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
      this.recorder = createWriteStream(file, { flags: 'a' });
      console.log(`[events] recording to ${file}`);
    }
  }

  setSnapshot(fn: () => SnapshotInput | Promise<SnapshotInput>): void {
    this.snapshotFn = fn;
  }

  on(fn: (e: DashboardEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: EventInput): void {
    const frame = { ...e, ts: Date.now() } as DashboardEvent;
    const json = JSON.stringify(frame);
    for (const s of this.sockets) if (s.readyState === s.OPEN) s.send(json);
    this.recorder?.write(json + '\n');
    for (const l of this.listeners) {
      try {
        l(frame);
      } catch (err) {
        console.error('[events] listener error', err);
      }
    }
  }

  get clients(): number {
    return this.sockets.size;
  }

  async handle(ws: WebSocket): Promise<void> {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('error', () => this.sockets.delete(ws));
    try {
      const snap = await this.snapshotFn();
      const frame = { type: 'snapshot', ts: Date.now(), ...snap };
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
      this.recorder?.write(JSON.stringify(frame) + '\n');
    } catch (err) {
      console.error('[events] snapshot failed', err);
    }
  }
}
