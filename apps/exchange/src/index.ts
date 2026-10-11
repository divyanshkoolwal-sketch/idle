import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { WebSocketServer } from 'ws';
import { loadEnv } from '@idle/shared';
import { loadConfig } from './config';
import { openDb } from './db';
import { Repo } from './db/repo';
import { EventBus } from './events';
import { loadReference } from './reference';
import type { Ctx } from './context';
import { ProviderRegistry } from './providers';
import { CredentialService } from './credentials';
import { AuctionEngine } from './auction';
import { Market } from './market';
import { Verifier } from './verify';
import { StreamHub } from './streams';
import { buildSnapshot, buildStats } from './snapshot';
import { mountRoutes } from './routes';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(appDir);

async function main() {
  const config = loadConfig(appDir);
  const dataDir = path.dirname(config.dbPath);
  const repo = new Repo(openDb(config.dbPath));
  const events = new EventBus(config.recordEvents ? dataDir : undefined);
  console.log(`[exchange] embedding golden set with ${config.embedModel} @ ${config.ollamaUrl} …`);
  const reference = await loadReference({ ollamaUrl: config.ollamaUrl, model: config.embedModel, dataDir });

  const ctx = { config, repo, events, reference } as Ctx;
  ctx.credentials = new CredentialService(ctx);
  ctx.registry = new ProviderRegistry(ctx);
  ctx.auctions = new AuctionEngine(ctx);
  ctx.market = new Market(ctx);
  ctx.verifier = new Verifier(ctx);
  ctx.streams = new StreamHub(ctx);
  events.setSnapshot(() => buildSnapshot(ctx));
  const statsTimer = setInterval(() => events.emit({ type: 'stats', stats: buildStats(ctx) }), 2000);

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, PAYMENT-SIGNATURE, X-PAYMENT');
    res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, Idempotency-Key, Retry-After');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: '8mb' }));
  mountRoutes(app, ctx);

  if (existsSync(config.dashboardDist)) {
    app.use(express.static(config.dashboardDist, { index: 'index.html' }));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/v1') && (req.headers.accept ?? '').includes('text/html')) {
        res.sendFile(path.join(config.dashboardDist, 'index.html'));
        return;
      }
      next();
    });
    console.log(`[exchange] serving dashboard from ${config.dashboardDist}`);
  } else {
    app.get('/', (_req, res) => res.type('text/plain').send('Idle exchange is running. Build the dashboard (pnpm build:dashboard) to serve it here.\n'));
  }
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[exchange] unhandled error:', msg);
    if (!res.headersSent) res.status(500).json({ error: 'INTERNAL', message: msg });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (p === '/v1/providers/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => ctx.registry.handleSocket(ws));
    } else if (p === '/v1/events') {
      wss.handleUpgrade(req, socket, head, (ws) => void ctx.events.handle(ws));
    } else if (p.startsWith('/v1/streams/')) {
      const quoteId = decodeURIComponent(p.slice('/v1/streams/'.length));
      wss.handleUpgrade(req, socket, head, (ws) => ctx.streams.handleSocket(ws, quoteId));
    } else {
      socket.destroy();
    }
  });

  server.listen(config.port, () => {
    console.log(`[exchange] listening on :${config.port}  payments=${config.payments} credentials=${config.credentials} rfq=${config.rfqWindowMs}ms ttl=${config.quoteTtlMs}ms spotcheck=${config.spotcheckRate}`);
    console.log(`[exchange] issuer ${ctx.credentials.issuerAddress}  providers known: ${ctx.registry.providers.size}`);
  });

  const shutdown = () => {
    console.log('[exchange] shutting down');
    clearInterval(statsTimer);
    ctx.registry.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[exchange] fatal:', e);
  process.exit(1);
});
