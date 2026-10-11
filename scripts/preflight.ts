/** Pre-stage checklist: run this before the demo. Every line must be ✔. */
import { loadEnv, REPO_ROOT, formatUnits, cosine } from '@idle/shared';
import { Wallet } from 'xrpl';
import { getXrpBalanceDrops, disconnectXrpl, lookupCredential } from '@idle/pay-xrpl';
import { ethBalance, ausdBalance } from '@idle/pay-evm';
import { privateKeyToAccount } from 'viem/accounts';
import { PROVIDER_ENV, readEnvValue, banner, ok, info } from './_lib';

loadEnv(REPO_ROOT);
let failures = 0;
const check = (cond: unknown, good: string, bad: string) => (cond ? ok(good) : (failures++, console.log(`\x1b[31m✘\x1b[0m ${bad}`)));
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const EXCHANGE = process.env.EXCHANGE_URL ?? 'http://localhost:8080';
const FACILITATOR = process.env.FACILITATOR_URL ?? 'http://localhost:4022';

async function main() {
  banner('preflight: keys');
  for (const k of ['FACILITATOR_PRIVATE_KEY', 'AGENT_EVM_PRIVATE_KEY', 'EXCHANGE_XRPL_SEED', 'AGENT_XRPL_SEED', 'ADMIN_TOKEN']) check(process.env[k], `${k} set`, `${k} missing (pnpm setup:wallets)`);
  check(readEnvValue(PROVIDER_ENV, 'PROVIDER_XRPL_SEED'), 'provider XRPL seed set', 'apps/provider/.env.local has no PROVIDER_XRPL_SEED');
  check(process.env.AUSD_EIP712_NAME && process.env.AUSD_DECIMALS, `AUSD domain pinned (${process.env.AUSD_EIP712_NAME} v${process.env.AUSD_EIP712_VERSION}, ${process.env.AUSD_DECIMALS} dp)`, 'AUSD domain not pinned (pnpm setup:ausd-domain)');
  info(`ANTHROPIC_API_KEY ${process.env.ANTHROPIC_API_KEY ? 'set (Claude loop)' : 'missing → scripted buyer'}   CONTEXT_DEV_API_KEY ${process.env.CONTEXT_DEV_API_KEY ? 'set' : 'missing → no web research'}`);

  banner('preflight: Ollama');
  try {
    const tags = (await (await fetch(`${OLLAMA}/api/tags`)).json()) as { models: { name: string }[] };
    const names = tags.models.map((m) => m.name);
    check(names.some((n) => n.startsWith('nomic-embed-text')), 'nomic-embed-text pulled', 'ollama pull nomic-embed-text');
    check(names.some((n) => n.startsWith('llama3.2')), 'llama3.2:3b pulled', 'ollama pull llama3.2:3b');
    const r = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', body: JSON.stringify({ model: 'nomic-embed-text', input: ['a cat sat on the mat', 'a kitten rests on the rug', 'quarterly bond yields rose'], options: { num_gpu: 0 } }) });
    const e = ((await r.json()) as { embeddings: number[][] }).embeddings;
    const near = cosine(e[0], e[1]);
    const far = cosine(e[0], e[2]);
    check(near > far + 0.15, `CPU embeddings discriminate (near ${near.toFixed(3)} vs far ${far.toFixed(3)})`, `CPU embeddings do not discriminate (near ${near.toFixed(3)} vs far ${far.toFixed(3)})`);
  } catch (e) {
    check(false, '', `Ollama unreachable at ${OLLAMA}: ${(e as Error).message}`);
  }

  banner('preflight: balances');
  const relayer = privateKeyToAccount(process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`).address;
  const agent = privateKeyToAccount(process.env.AGENT_EVM_PRIVATE_KEY as `0x${string}`).address;
  const [rEth, aEth, aAusd] = await Promise.all([ethBalance(relayer), ethBalance(agent), ausdBalance(agent)]);
  check(rEth >= 5n * 10n ** 13n, `relayer ETH ${formatUnits(rEth, 18, 6)}`, `relayer ${relayer} has ${formatUnits(rEth, 18, 6)} ETH (fund it)`);
  check(aAusd >= 10n ** 6n, `agent AUSD ${formatUnits(aAusd, 6, 2)}`, `agent ${agent} has ${formatUnits(aAusd, 6, 2)} AUSD (pnpm setup:fund; needs ${formatUnits(aEth, 18, 6)} ETH → faucet)`);
  const issuer = Wallet.fromSeed(process.env.EXCHANGE_XRPL_SEED!);
  const buyer = Wallet.fromSeed(process.env.AGENT_XRPL_SEED!);
  const prov = Wallet.fromSeed(readEnvValue(PROVIDER_ENV, 'PROVIDER_XRPL_SEED')!);
  for (const [n, w] of [['issuer', issuer], ['agent', buyer], ['provider', prov]] as const) {
    const b = await getXrpBalanceDrops(w.address);
    check(b >= 20_000_000n, `${n} XRP ${formatUnits(b, 6)}`, `${n} ${w.address} has ${formatUnits(b, 6)} XRP (pnpm setup:fund)`);
  }

  banner('preflight: services');
  try {
    const h = (await (await fetch(`${FACILITATOR}/health`)).json()) as { relayer: string };
    check(h.relayer?.toLowerCase() === relayer.toLowerCase(), `facilitator up (${FACILITATOR})`, 'facilitator relayer mismatch');
  } catch {
    check(false, '', `facilitator not reachable at ${FACILITATOR} (PAYMENTS=on scripts/stack.sh up)`);
  }
  try {
    const m = (await (await fetch(`${EXCHANGE}/v1/market`)).json()) as { providers: { name: string; status: string; online: boolean; xrplAddress: string; tier?: string }[]; issuer: string };
    const live = m.providers.filter((p) => p.online && p.status === 'verified');
    check(live.length >= 1, `exchange up with ${live.length} verified provider(s): ${live.map((p) => p.name).join(', ')}`, 'exchange has no verified online provider (scripts/stack.sh provider)');
    check(m.issuer === issuer.address, 'exchange issuer matches EXCHANGE_XRPL_SEED', `issuer mismatch ${m.issuer}`);
    for (const p of live.slice(0, 3)) {
      const c = await lookupCredential(p.xrplAddress, m.issuer, `IDLE_DC_TIER_${p.tier ?? 'A'}`);
      check(c.exists && c.accepted && !c.expired, `${p.name} credential accepted on-ledger`, `${p.name} credential not valid on-ledger (${JSON.stringify(c)})`);
    }
  } catch (e) {
    check(false, '', `exchange not reachable at ${EXCHANGE}: ${(e as Error).message}`);
  }
  banner(failures ? `${failures} problem(s)` : 'ready');
  await disconnectXrpl();
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await disconnectXrpl();
  process.exit(1);
});
