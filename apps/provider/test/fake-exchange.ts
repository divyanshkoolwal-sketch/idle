/**
 * Fake exchange: speaks the provider protocol end to end against a real provider process.
 *   hello → welcome → challenge (verified with our own Ollama) → real XRPL credential (create/offer/accept/lookup)
 *   → rfq/bid timing → award/job (embed + generate, results verified) → pass on impossible deadline
 *   → XRPL stream with real channel + signed claims (pause when unpaid > 32, stop early, final claim, on-ledger claim)
 *   → cheat mode (sub-floor bid + random vectors caught) → drain (graceful offline).
 * Run: pnpm --filter @idle/provider test:e2e
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { GOLDEN_TEXTS, ProviderMessage, REPO_ROOT, cosine, loadEnv, xrplTx, xrplAccount } from '@idle/shared';
import type { ExchangeMessage } from '@idle/shared';
import { createCredential, deleteCredential, lookupCredential, disconnectXrpl, ensureFunded, getChannel, openChannel, signClaim, walletFromSeed } from '@idle/pay-xrpl';
import { Ollama } from '../src/ollama';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(APP_DIR);

const PORT = 18080;
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'nomic-embed-text';
const GEN_MODEL = process.env.GEN_MODEL ?? 'llama3.2:3b';
const CRED_TYPE = 'IDLE_DC_TIER_A';
const DROPS_PER_TOKEN = 40n;
const REF_EMBED = { numGpu: Number(process.env.REF_EMBED_NUM_GPU ?? '0') }; // reference vectors on CPU: Metal embeddings are broken on this machine

type PM = ProviderMessage;
type Of<T extends PM['type']> = Extract<PM, { type: T }>;

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name} ${detail ?? ''}`);
};
const say = (m: string) => console.log(`\x1b[36m[fake-exchange]\x1b[0m ${m}`);

// ---------------------------------------------------------------- inbox
const inbox: PM[] = [];
const waiters: { pred: (m: PM) => boolean; resolve: (m: PM) => void }[] = [];
function push(m: PM) {
  const i = waiters.findIndex((w) => w.pred(m));
  if (i >= 0) {
    const w = waiters.splice(i, 1)[0];
    w.resolve(m);
    return;
  }
  if (m.type !== 'heartbeat') inbox.push(m);
}
/** One registration per call: the first inbox/incoming frame matching `pred` resolves it (no leaked waiters). */
function nextMatch(pred: (m: PM) => boolean, label: string, timeoutMs = 60_000): Promise<PM> {
  const i = inbox.findIndex(pred);
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waiters.findIndex((w) => w.resolve === res);
      if (idx >= 0) waiters.splice(idx, 1);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    const res = (m: PM) => {
      clearTimeout(timer);
      resolve(m);
    };
    waiters.push({ pred, resolve: res });
  });
}
function next<T extends PM['type']>(type: T, pred: (m: Of<T>) => boolean = () => true, timeoutMs = 60_000): Promise<Of<T>> {
  return nextMatch((m) => m.type === type && pred(m as Of<T>), type, timeoutMs) as Promise<Of<T>>;
}

const shuffle = <T,>(xs: readonly T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const minCos = (a: number[][], b: number[][]) => Math.min(...a.map((v, i) => cosine(v, b[i])));

async function main() {
  const issuer = walletFromSeed(process.env.EXCHANGE_XRPL_SEED!);
  const agent = walletFromSeed(process.env.AGENT_XRPL_SEED!);
  const ollama = new Ollama(process.env.OLLAMA_URL ?? 'http://localhost:11434');
  say(`issuer ${issuer.address} · buyer ${agent.address}`);
  await Promise.all([ensureFunded(issuer), ensureFunded(agent)]);

  const wss = new WebSocketServer({ port: PORT, path: '/v1/providers/ws' });
  let sock: WebSocket | undefined;
  const send = (m: ExchangeMessage) => sock!.send(JSON.stringify(m));
  const connected = new Promise<void>((resolve) => {
    wss.on('connection', (ws) => {
      sock = ws;
      ws.on('message', (data) => {
        const parsed = ProviderMessage.safeParse(JSON.parse(data.toString()));
        if (!parsed.success) {
          console.error('invalid provider frame', parsed.error.issues[0]);
          return;
        }
        push(parsed.data);
      });
      resolve();
    });
  });
  const closed = new Promise<void>((resolve) => wss.on('connection', (ws) => ws.on('close', () => resolve())));

  // spawn the real provider
  const tsx = path.join(REPO_ROOT, 'node_modules/.bin/tsx');
  const child = spawn(tsx, ['src/index.ts', '--exchange', `http://localhost:${PORT}`, '--name', 'DC-Test-1', '--region', 'test · laptop', '--slots', '2'], {
    cwd: APP_DIR,
    env: { ...process.env, CHEAT: 'false', PROVIDER_PERSIST_ID: '0', PROVIDER_ID: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pipe = (s: NodeJS.ReadableStream) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        console.log(`  \x1b[90m│\x1b[0m ${buf.slice(0, nl)}`);
        buf = buf.slice(nl + 1);
      }
    });
  };
  pipe(child.stdout!);
  pipe(child.stderr!);
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  let providerXrpl = '';
  let credentialIssued = false;

  try {
    await connected;
    // 1. hello / welcome
    const hello = await next('hello', () => true, 180_000);
    providerXrpl = hello.xrplAddress;
    check('hello received', hello.name === 'DC-Test-1' && hello.slots === 2 && hello.benchmark.embedTps > 0, `${hello.hardware.label} · embed ${hello.benchmark.embedTps}/s gen ${hello.benchmark.genTps} tok/s · xrpl ${hello.xrplAddress}`);
    send({ type: 'welcome', providerId: 'prov-test-1', issuerAddress: issuer.address, status: 'pending' });

    // 2. challenge
    const texts = [...shuffle(GOLDEN_TEXTS), `nonce ${Math.random().toString(36).slice(2)}`];
    const t0 = Date.now();
    send({ type: 'challenge', challengeId: 'c1', model: EMBED_MODEL, texts, deadlineMs: 5000 });
    const cr = await next('challenge.result');
    const ref = await ollama.embed(EMBED_MODEL, texts, REF_EMBED);
    const mc = minCos(cr.embeddings, ref.embeddings);
    check('challenge answered honestly', cr.embeddings.length === texts.length && mc >= 0.995 && Date.now() - t0 < 5000, `min cosine ${mc.toFixed(4)} in ${Date.now() - t0} ms`);

    // 3. real credential on XRPL testnet
    const pre = await lookupCredential(providerXrpl, issuer.address, CRED_TYPE);
    if (pre.exists) await deleteCredential(issuer, providerXrpl, CRED_TYPE);
    const issued = await createCredential(issuer, providerXrpl, CRED_TYPE, { uri: `http://localhost:${PORT}/providers/prov-test-1`, expiresInMs: 24 * 3600_000 });
    credentialIssued = true;
    say(`CredentialCreate ${xrplTx(issued.txHash)}`);
    send({ type: 'credential.offered', credentialType: CRED_TYPE, issuer: issuer.address, txHash: issued.txHash, tier: 'A' });
    const acc = await next('credential.accepted', () => true, 60_000);
    let look = await lookupCredential(providerXrpl, issuer.address, CRED_TYPE);
    for (let i = 0; i < 10 && !(look.exists && look.accepted); i++) {
      await new Promise((r) => setTimeout(r, 2000)); // our node may trail the provider's node by a ledger
      look = await lookupCredential(providerXrpl, issuer.address, CRED_TYPE);
    }
    check('provider accepted the credential on-ledger (lsfAccepted)', look.exists && look.accepted, xrplTx(acc.txHash));
    send({ type: 'verified', tier: 'A' });

    // 4. heartbeat
    const hb = await next('heartbeat');
    check('heartbeat with asks', hb.asks.embed === '15' && hb.asks.generate === '25' && hb.asks.stream === '40' && !hb.draining, `busy ${hb.busySlots}/2 shade ${hb.shade} surge ${hb.surge} asks ${JSON.stringify(hb.asks)}`);

    // 5. embed auction + job
    const embedTexts = Array.from({ length: 32 }, (_, i) => `Sentence ${i}: ${GOLDEN_TEXTS[i % GOLDEN_TEXTS.length]}`);
    const r1 = Date.now();
    send({ type: 'rfq', auctionId: 'a1', jobType: 'embed', model: EMBED_MODEL, units: 32, currency: 'AUSD', maxUnitPrice: '1000', deadlineMs: 10_000, closeAt: r1 + 250 });
    const bid1 = await next('bid', (b) => b.auctionId === 'a1', 5000);
    const lat1 = Date.now() - r1;
    check('bid within 250 ms at floor', lat1 < 250 && BigInt(bid1.unitPrice) >= 15n && BigInt(bid1.unitPrice) <= 16n, `${bid1.unitPrice} µAUSD/text, eta ${bid1.etaMs} ms, in ${lat1} ms`);
    send({ type: 'award', auctionId: 'a1', clearingUnitPrice: bid1.unitPrice, quoteExpiresAt: Date.now() + 15_000 });
    send({ type: 'job', jobId: 'j1', auctionId: 'a1', jobType: 'embed', model: EMBED_MODEL, input: { texts: embedTexts }, unitPrice: bid1.unitPrice, currency: 'AUSD' });
    const res1 = await next('result', (r) => r.jobId === 'j1');
    if (!res1.ok || !res1.output) throw new Error(`embed job failed: ${res1.ok ? "no output" : res1.error}`);
    const ref1 = await ollama.embed(EMBED_MODEL, embedTexts, REF_EMBED);
    const mc1 = minCos(res1.output.embeddings!, ref1.embeddings);
    check('embed job result correct', res1.output.embeddings!.length === 32 && mc1 >= 0.995, `min cosine ${mc1.toFixed(4)} in ${res1.ms} ms`);

    // 6. generate auction + job
    const r2 = Date.now();
    send({ type: 'rfq', auctionId: 'a2', jobType: 'generate', model: GEN_MODEL, units: 64, currency: 'AUSD', maxUnitPrice: '1000', deadlineMs: 30_000, closeAt: r2 + 250 });
    const bid2 = await next('bid', (b) => b.auctionId === 'a2', 5000);
    check('generate bid at floor', BigInt(bid2.unitPrice) >= 25n && BigInt(bid2.unitPrice) <= 26n, `${bid2.unitPrice} µAUSD/token, eta ${bid2.etaMs} ms`);
    send({ type: 'award', auctionId: 'a2', clearingUnitPrice: bid2.unitPrice, quoteExpiresAt: Date.now() + 15_000 });
    send({ type: 'job', jobId: 'j2', auctionId: 'a2', jobType: 'generate', model: GEN_MODEL, input: { prompt: 'In one sentence, why do spot markets exist for compute?', maxTokens: 64 }, unitPrice: bid2.unitPrice, currency: 'AUSD' });
    const res2 = await next('result', (r) => r.jobId === 'j2', 120_000);
    if (!res2.ok || !res2.output) throw new Error(`generate job failed: ${res2.ok ? "no output" : res2.error}`);
    check('generate job result', (res2.output.text ?? '').length > 0 && (res2.output.tokens ?? 0) > 0 && (res2.output.tokens ?? 0) <= 64, `${res2.output.tokens} tokens in ${res2.ms} ms: "${res2.output.text!.replace(/\s+/g, ' ').slice(0, 80)}…"`);

    // 7. pass on impossible deadline; lose feeds the learner
    send({ type: 'rfq', auctionId: 'a3', jobType: 'embed', model: EMBED_MODEL, units: 64, currency: 'AUSD', maxUnitPrice: '1000', deadlineMs: 1, closeAt: Date.now() + 250 });
    const pass = await next('pass', (p) => p.auctionId === 'a3', 5000);
    check('passes when eta exceeds deadline', /deadline/.test(pass.reason), pass.reason);
    send({ type: 'lose', auctionId: 'a4', clearingUnitPrice: '14' });

    // 8. XRPL stream with a real channel
    const ch = await openChannel(agent, providerXrpl, 10_000_000n, 60);
    say(`PaymentChannelCreate ${xrplTx(ch.txHash)} channel ${ch.channelId}`);
    send({
      type: 'stream.start',
      streamId: 's1',
      jobId: 'j3',
      model: GEN_MODEL,
      prompt: 'Write a detailed, multi-paragraph explanation of how sealed-bid second-price auctions work and why they are truthful.',
      maxTokens: 400,
      channelId: ch.channelId,
      buyerAddress: agent.address,
      buyerPublicKey: agent.publicKey,
      dropsPerToken: DROPS_PER_TOKEN.toString(),
      priorClaimedDrops: '0',
    });
    let delivered = 0;
    let paused: number | undefined;
    let stopSent = false;
    let claimsSent = 0;
    const claim = (tokens: number) => {
      const drops = BigInt(tokens) * DROPS_PER_TOKEN;
      send({ type: 'stream.claim', streamId: 's1', amountDrops: drops.toString(), signature: signClaim(agent, ch.channelId, drops) });
      claimsSent++;
    };
    const streamDone = (async () => {
      for (;;) {
        const m = (await nextMatch(
          (x) => (x.type === 'stream.token' || x.type === 'stream.paused' || x.type === 'stream.end') && x.streamId === 's1',
          'stream frame',
          60_000,
        )) as Of<'stream.token'> | Of<'stream.paused'> | Of<'stream.end'>;
        if (m.type === 'stream.token') {
          delivered++;
          if (delivered === m.index + 1 && delivered === 16) claim(16); // pay for the first 16 …
          // … then withhold claims (32 and 48 skipped) so the provider must pause at unpaid > 32
          if (delivered >= 60 && !stopSent) {
            stopSent = true;
            send({ type: 'stream.stop', streamId: 's1' });
          }
        } else if (m.type === 'stream.paused') {
          paused = m.unpaidTokens;
          say(`provider paused with ${m.unpaidTokens} unpaid tokens → paying up`);
          claim(delivered);
        } else {
          return m;
        }
      }
    })();
    const end = await streamDone;
    check('stream paused when unpaid tokens exceeded the credit window', paused !== undefined && paused > 32, `paused at ${paused} unpaid`);
    check('stream ended on stop', end.reason === 'stopped' && end.tokensDelivered === delivered && delivered >= 60, `${end.tokensDelivered} tokens delivered`);
    claim(delivered); // final claim covering exactly the delivered tokens, signed after `end`
    const claimed = await next('stream.claimed', (c) => c.streamId === 's1', 90_000);
    const expect = BigInt(delivered) * DROPS_PER_TOKEN;
    check('on-ledger claim == delivered × dropsPerToken', BigInt(claimed.drops) === expect && claimed.tokens === delivered, `${claimed.drops} drops for ${claimed.tokens} tokens (${claimsSent} claims) ${xrplTx(claimed.txHash)}`);
    const onLedger = await getChannel(ch.channelId);
    check('ledger channel Balance matches', onLedger?.balanceDrops === expect, `Balance ${onLedger?.balanceDrops} drops`);

    // 9. cheat mode
    send({ type: 'cheat', on: true });
    await new Promise((r) => setTimeout(r, 200));
    send({ type: 'rfq', auctionId: 'a5', jobType: 'embed', model: EMBED_MODEL, units: 8, currency: 'AUSD', maxUnitPrice: '1000', deadlineMs: 10_000, closeAt: Date.now() + 250 });
    const bid5 = await next('bid', (b) => b.auctionId === 'a5', 5000);
    check('cheat mode bids 40% below floor', BigInt(bid5.unitPrice) <= 9n, `${bid5.unitPrice} µAUSD/text (floor 15)`);
    send({ type: 'award', auctionId: 'a5', clearingUnitPrice: bid5.unitPrice, quoteExpiresAt: Date.now() + 15_000 });
    const cheatTexts = embedTexts.slice(0, 8);
    send({ type: 'job', jobId: 'j5', auctionId: 'a5', jobType: 'embed', model: EMBED_MODEL, input: { texts: cheatTexts }, unitPrice: bid5.unitPrice, currency: 'AUSD' });
    const res5 = await next('result', (r) => r.jobId === 'j5');
    if (!res5.ok || !res5.output) throw new Error(`cheat job failed: ${res5.ok ? "no output" : res5.error}`);
    const mc5 = minCos(res5.output.embeddings!, ref1.embeddings.slice(0, 8));
    const maxCos5 = Math.max(...res5.output.embeddings!.map((v, i) => cosine(v, ref1.embeddings[i])));
    check('cheat vectors are caught by a spot check (cosine ≈ 0)', res5.output.embeddings!.length === 8 && maxCos5 < 0.5, `max cosine ${maxCos5.toFixed(3)}, min ${mc5.toFixed(3)}`);
    send({ type: 'cheat', on: false });

    // 10. drain while a job is running: no new bids, running work finishes, then offline
    send({ type: 'rfq', auctionId: 'a7', jobType: 'generate', model: GEN_MODEL, units: 160, currency: 'AUSD', maxUnitPrice: '1000', deadlineMs: 60_000, closeAt: Date.now() + 250 });
    const bid7 = await next('bid', (b) => b.auctionId === 'a7', 5000);
    send({ type: 'award', auctionId: 'a7', clearingUnitPrice: bid7.unitPrice, quoteExpiresAt: Date.now() + 15_000 });
    send({ type: 'job', jobId: 'j7', auctionId: 'a7', jobType: 'generate', model: GEN_MODEL, input: { prompt: 'Explain, in detail, how a second-price auction works.', maxTokens: 160 }, unitPrice: bid7.unitPrice, currency: 'AUSD' });
    await new Promise((r) => setTimeout(r, 300)); // let the job start
    send({ type: 'drain', on: true });
    const hbd = await next('heartbeat', (h) => h.draining, 10_000);
    check('heartbeat reports draining', hbd.draining && hbd.busySlots === 1, `busy ${hbd.busySlots}`);
    send({ type: 'rfq', auctionId: 'a6', jobType: 'embed', model: EMBED_MODEL, units: 8, currency: 'AUSD', maxUnitPrice: '1000', deadlineMs: 10_000, closeAt: Date.now() + 250 });
    const pass6 = await next('pass', (p) => p.auctionId === 'a6', 5000);
    check('draining provider passes on new RFQs', pass6.reason === 'draining', pass6.reason);
    const res7 = await next('result', (r) => r.jobId === 'j7', 120_000);
    check('running job finished during drain', res7.ok && (res7.output?.tokens ?? 0) > 0, res7.ok ? `${res7.output?.tokens} tokens` : res7.error);
    await closed;
    const code = await Promise.race([exited, new Promise<number | null>((r) => setTimeout(() => r(null), 15_000))]);
    check('provider went offline gracefully', code === 0, `socket closed, exit code ${code}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (credentialIssued) {
      await deleteCredential(issuer, providerXrpl, CRED_TYPE).then((d) => say(`cleanup CredentialDelete ${xrplTx(d.txHash)}`)).catch((e) => say(`cleanup failed: ${(e as Error).message}`));
    }
    wss.close();
    await disconnectXrpl().catch(() => undefined);
  }
  const bad = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - bad}/${checks.length} checks passed · provider ${xrplAccount(providerXrpl)}`);
  process.exit(bad ? 1 : 0);
}

const watchdog = setTimeout(() => {
  console.error('fake-exchange: global timeout');
  process.exit(1);
}, 8 * 60_000);
watchdog.unref();

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
