/** Dumps every `/v1/events` frame to a JSONL file (default /tmp/idle-events.jsonl) — handy for dashboard replay fixtures. */
import WebSocket from 'ws';
import { appendFileSync } from 'node:fs';
const out = process.argv[2] ?? '/tmp/idle-events.jsonl';
const ws = new WebSocket((process.env.EXCHANGE_URL ?? 'http://localhost:8080').replace(/^http/, 'ws') + '/v1/events');
ws.on('message', (d) => appendFileSync(out, d.toString() + '\n'));
ws.on('open', () => console.log(`listening → ${out}`));
ws.on('close', () => process.exit(0));
