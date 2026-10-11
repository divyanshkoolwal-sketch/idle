import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ExchangeMessage } from '@idle/shared';
import type { Inbound, Outbound } from './types';
import type { Logger } from './log';

export interface ConnectionEvents {
  open: [];
  message: [Inbound];
  close: [code: number, reason: string];
}

/**
 * Websocket client to the exchange with reconnect + backoff and a ping/pong watchdog
 * (half-open sockets after sleep are terminated so a fresh connection is made on wake).
 */
export class ExchangeConnection extends EventEmitter<ConnectionEvents> {
  private ws?: WebSocket;
  private closedByUs = false;
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private pongTimer?: NodeJS.Timeout;
  readonly url: string;

  constructor(exchangeUrl: string, private readonly log: Logger, private readonly opts: { pingIntervalMs?: number; pongTimeoutMs?: number; maxBackoffMs?: number } = {}) {
    super();
    this.url = `${exchangeUrl.replace(/^http/, 'ws')}/v1/providers/ws`;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.closedByUs = false;
    clearTimeout(this.reconnectTimer);
    this.log.info(`connecting to ${this.url}${this.attempt ? ` (attempt ${this.attempt + 1})` : ''}`);
    const ws = new WebSocket(this.url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.startWatchdog();
      this.emit('open');
    });
    ws.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        this.log.warn('non-JSON frame from exchange ignored');
        return;
      }
      const parsed = ExchangeMessage.safeParse(raw);
      if (!parsed.success) {
        const t = (raw as { type?: string })?.type ?? '?';
        this.log.warn(`invalid "${t}" frame from exchange: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
        return;
      }
      this.emit('message', parsed.data);
    });
    ws.on('pong', () => clearTimeout(this.pongTimer));
    ws.on('error', (err) => this.log.warn(`socket error: ${err.message}`));
    ws.on('close', (code, reason) => {
      this.stopWatchdog();
      if (this.ws === ws) this.ws = undefined;
      this.emit('close', code, reason.toString());
      this.scheduleReconnect();
    });
  }

  send(msg: Outbound): boolean {
    if (!this.isOpen) return false;
    try {
      this.ws!.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      this.log.warn(`send ${msg.type} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Graceful close; no reconnect afterwards. */
  close(code = 1000, reason = 'bye'): void {
    this.closedByUs = true;
    clearTimeout(this.reconnectTimer);
    this.stopWatchdog();
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close(code, reason);
  }

  private scheduleReconnect(): void {
    if (this.closedByUs) return;
    const base = Math.min(this.opts.maxBackoffMs ?? 30_000, 1000 * 2 ** this.attempt);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.attempt++;
    this.log.info(`reconnecting in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startWatchdog(): void {
    const interval = this.opts.pingIntervalMs ?? 10_000;
    const timeout = this.opts.pongTimeoutMs ?? 10_000;
    this.stopWatchdog();
    this.pingTimer = setInterval(() => {
      if (!this.isOpen) return;
      this.ws!.ping();
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        this.log.warn('no pong from exchange; terminating stale socket');
        this.ws?.terminate();
      }, timeout);
    }, interval);
  }

  private stopWatchdog(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
  }
}
