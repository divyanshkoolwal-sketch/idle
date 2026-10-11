/**
 * Minimal data-center daemon that speaks the provider WS protocol, for exchange acceptance tests.
 *   pnpm tsx apps/exchange/test/fake-provider.ts --name DC-Fake-1 --floor 15 --slots 2 [--seed sEd...] [--cheat] [--region "us-west · Berkeley"]
 * Honest during the onboarding challenge; `--cheat` undercuts floors by 40% and returns random unit vectors for jobs.
 */
import os from 'node:os';
import WebSocket from 'ws';
import { Wallet } from 'xrpl';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ExchangeMessage, loadEnv, REPO_ROOT } from '@idle/shared';
import type { ProviderMessage } from '@idle/shared';
import { acceptCredential, disconnectXrpl, ensureFunded } from '@idle/pay-xrpl';
import { ollamaEmbed } from '../src/reference';

loadEnv(REPO_ROOT);
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? 'true') : d;
};
const flag = (n: string) => process.argv.includes(`--${n}`);

const NAME = arg('name', `DC-Fake-${os.hostname().slice(0, 6)}`)!;
const REGION = arg('region', 'us-west · Berkeley')!;
const FLOOR_EMBED = BigInt(arg('floor', '15')!);
const FLOOR_GEN = BigInt(arg('gen-floor', (FLOOR_EMBED * 2n).toString())!);
const FLOOR_STREAM = BigInt(arg('stream-floor', '40')!);
const SLOTS = Number(arg('slots', '2'));
const EXCHANGE = (arg('exchange', process.env.EXCHANGE_URL ?? 'http://localhost:8080') as string).replace(/\/$/, '');
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'nomic-embed-text';
const GEN_MODEL = process.env.GEN_MODEL ?? 'llama3.2:3b';
let cheat = flag('cheat');
let draining = false;

const xrpl = arg('seed') ? Wallet.fromSeed(arg('seed')!) : Wallet.generate();
const evm = privateKeyToAccount(generatePrivateKey()).address;
const log = (m: string) => console.log(`[${NAME}] ${m}`);

let providerId: string | undefined;
let busy = 0;
let queue = 0;
let shade = 1;
const recent: boolean[] = [];
const avgJobMs = 800;
const embedTps = 60;
const genTps = 22;

function surge(): number {
  const u = busy / SLOTS;
  return 1 + 1.5 * u * u;
}
function asks() {
  const s = surge();
  const f = (v: bigint) => (BigInt(Math.round(Number(v) * s * shade)) || 1n).toString();
  return { embed: f(FLOOR_EMBED), generate: f(FLOOR_GEN), stream: f(FLOOR_STREAM) };
}
function randomUnitVectors(n: number, dim: number): number[][] {
  return Array.from({ length: n }, () => {
    const v = Array.from({ length: dim }, () => {
      const u = Math.random() || 1e-9;
      const w = Math.random();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
    });
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  });
}
async function generate(prompt: string, maxTokens: number): Promise<{ text: string; tokens: number }> {
  const r = await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model: GEN_MODEL, prompt, stream: false, options: { num_predict: maxTokens, temperature: 0.2 } }) });
  if (!r.ok) throw new Error(`ollama generate ${r.status}`);
  const j = (await r.json()) as { response: string; eval_count?: number };
  return { text: j.response, tokens: j.eval_count ?? 0 };
}

function connect() {
  const url = EXCHANGE.replace(/^http/, 'ws') + '/v1/providers/ws';
  const ws = new WebSocket(url);
  const send = (m: ProviderMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  let hb: NodeJS.Timeout | undefined;

  ws.on('open', () => {
    log(`connected to ${url}`);
    send({
      type: 'hello',
      providerId,
      name: NAME,
      region: REGION,
      hardware: { cpu: os.cpus()[0]?.model ?? 'cpu', ramGb: Math.round(os.totalmem() / 2 ** 30), label: `${os.cpus()[0]?.model ?? 'cpu'} · ${Math.round(os.totalmem() / 2 ** 30)} GB` },
      evmAddress: evm,
      xrplAddress: xrpl.address,
      xrplPublicKey: xrpl.publicKey,
      models: [EMBED_MODEL, GEN_MODEL],
      slots: SLOTS,
      benchmark: { embedTps, genTps, embedMs: 1000, genMs: 2500 },
      floors: { embed: FLOOR_EMBED.toString(), generate: FLOOR_GEN.toString(), streamDrops: FLOOR_STREAM.toString() },
      cheat,
      version: 'fake-0.1',
    });
    hb = setInterval(() => send({ type: 'heartbeat', busySlots: busy, queueDepth: queue, shade, surge: surge(), asks: asks(), draining, cheat }), 1000);
  });

  ws.on('message', async (data) => {
    const parsed = ExchangeMessage.safeParse(JSON.parse(data.toString()));
    if (!parsed.success) return log(`bad message: ${parsed.error.message.slice(0, 120)}`);
    const msg = parsed.data;
    switch (msg.type) {
      case 'welcome':
        providerId = msg.providerId;
        log(`welcome: id=${providerId} status=${msg.status} issuer=${msg.issuerAddress}`);
        return;
      case 'challenge': {
        const t0 = Date.now();
        try {
          const embeddings = await ollamaEmbed(OLLAMA, msg.model, msg.texts);
          send({ type: 'challenge.result', challengeId: msg.challengeId, embeddings, ms: Date.now() - t0 });
          log(`answered challenge (${msg.texts.length} texts) in ${Date.now() - t0} ms`);
        } catch (e) {
          log(`challenge embed failed: ${(e as Error).message}`);
        }
        return;
      }
      case 'challenge.failed':
        log(`challenge failed: ${msg.reason}`);
        return;
      case 'credential.offered': {
        log(`credential offered: ${msg.credentialType} by ${msg.issuer} (issue tx ${msg.txHash}); accepting…`);
        try {
          const { txHash } = await acceptCredential(xrpl, msg.issuer, msg.credentialType);
          send({ type: 'credential.accepted', txHash });
          log(`CredentialAccept ${txHash}`);
        } catch (e) {
          log(`accept failed: ${(e as Error).message}`);
        }
        return;
      }
      case 'verified':
        log(`VERIFIED tier ${msg.tier}`);
        return;
      case 'rfq': {
        if (draining || busy + queue >= SLOTS) return send({ type: 'pass', auctionId: msg.auctionId, reason: draining ? 'draining' : 'no free slot' });
        const floor = msg.jobType === 'embed' ? FLOOR_EMBED : msg.jobType === 'generate' ? FLOOR_GEN : FLOOR_STREAM;
        const jitter = 1 + (Math.random() * 0.06 - 0.03);
        let price = Number(floor) * surge() * shade * jitter;
        if (cheat) price = Number(floor) * 0.6;
        const unitPrice = Math.max(1, Math.round(price));
        const tp = msg.jobType === 'embed' ? embedTps : genTps;
        const etaMs = Math.round(queue * avgJobMs + (msg.units / tp) * 1000 + 150);
        send({ type: 'bid', auctionId: msg.auctionId, unitPrice: String(unitPrice), etaMs, shade, surge: surge() });
        return;
      }
      case 'award':
      case 'lose': {
        recent.push(msg.type === 'award');
        if (recent.length > 10) recent.shift();
        const winRate = recent.filter(Boolean).length / recent.length;
        if (recent.length >= 5) {
          if (winRate < 0.3) shade = Math.max(1, shade * 0.95);
          else if (winRate > 0.6) shade = Math.min(3, shade * 1.05);
        }
        return;
      }
      case 'release':
        return;
      case 'job': {
        busy++;
        const t0 = Date.now();
        try {
          if (msg.jobType === 'embed') {
            const texts = msg.input.texts ?? [];
            const embeddings = cheat ? randomUnitVectors(texts.length, 768) : await ollamaEmbed(OLLAMA, msg.model, texts);
            send({ type: 'result', jobId: msg.jobId, ok: true, output: { embeddings }, ms: Date.now() - t0 });
          } else {
            const g = await generate(msg.input.prompt ?? '', msg.input.maxTokens ?? 64);
            send({ type: 'result', jobId: msg.jobId, ok: true, output: { text: g.text, tokens: g.tokens }, ms: Date.now() - t0 });
          }
          if (!msg.jobId.startsWith('v_')) log(`job ${msg.jobId} ${msg.jobType}×${msg.input.texts?.length ?? msg.input.maxTokens} @ ${msg.unitPrice} done in ${Date.now() - t0} ms${cheat ? ' (CHEATING)' : ''}`);
        } catch (e) {
          send({ type: 'result', jobId: msg.jobId, ok: false, error: (e as Error).message });
        } finally {
          busy--;
        }
        return;
      }
      case 'stream.start':
        send({ type: 'stream.end', streamId: msg.streamId, tokensDelivered: 0, reason: 'error', error: 'fake provider does not stream' });
        return;
      case 'drain':
        draining = msg.on;
        log(`drain=${draining}`);
        return;
      case 'cheat':
        cheat = msg.on;
        log(`cheat=${cheat}`);
        return;
      case 'error':
        log(`exchange error ${msg.code}: ${msg.message}`);
        return;
      default:
        return;
    }
  });

  ws.on('close', (code) => {
    if (hb) clearInterval(hb);
    log(`disconnected (${code}); reconnecting in 2s`);
    setTimeout(connect, 2000);
  });
  ws.on('error', (e) => log(`ws error: ${e.message}`));
}

async function main() {
  log(`xrpl ${xrpl.address}  evm ${evm}  floors embed=${FLOOR_EMBED} gen=${FLOOR_GEN} stream=${FLOOR_STREAM}  slots=${SLOTS}${cheat ? '  CHEAT' : ''}`);
  if (flag('fund')) {
    await ensureFunded(xrpl, 20);
    log('xrpl funded');
  }
  // warm the embed model so the challenge answers fast
  await ollamaEmbed(OLLAMA, EMBED_MODEL, ['warm up']).catch((e) => log(`warm-up failed: ${(e as Error).message}`));
  connect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
process.on('SIGINT', async () => {
  await disconnectXrpl().catch(() => undefined);
  process.exit(0);
});
