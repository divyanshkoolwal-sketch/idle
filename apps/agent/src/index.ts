import { cfg } from './config';
import { Wallet } from 'xrpl';
import { formatUnits } from '@idle/shared';
import { ensureFunded, disconnectXrpl } from '@idle/pay-xrpl';
import { AgentLogger } from './log';
import { PERSONAS, type Persona } from './personas';
import { MarketClient } from './market';
import { XrpBudget } from './stream';
import { runClaudeAgent, type AgentDeps } from './claude';
import { runScripted } from './scripted';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const personaName = (arg('persona') ?? 'analyst') as Persona['name'];
  const persona = PERSONAS[personaName];
  if (!persona) throw new Error(`unknown persona ${personaName}`);
  const indexUrl = arg('index');
  const jobs = arg('jobs') ? Number(arg('jobs')) : undefined;
  const stopAfterTokens = arg('stop-after') ? Number(arg('stop-after')) : undefined;
  const streamArg = arg('stream');
  const positional = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && !(arr[i - 1]?.startsWith('--') && !['--scripted', '--quiet'].includes(arr[i - 1]))).join(' ') || undefined;
  const streamPrompt = streamArg && !streamArg.startsWith('--') ? streamArg : flag('stream') ? positional ?? 'Write a short paragraph about idle GPUs and agents that buy compute by the job.' : undefined;
  const streamMaxTokens = arg('max-tokens') ? Number(arg('max-tokens')) : undefined;
  const question = streamPrompt ? undefined : positional;
  const scripted = flag('scripted') || !!jobs || !!streamPrompt || !process.env.ANTHROPIC_API_KEY;
  if (!flag('scripted') && !jobs && !streamPrompt && !process.env.ANTHROPIC_API_KEY) console.warn('[agent] ANTHROPIC_API_KEY not set — running the scripted buyer instead of the Claude loop');

  const log = new AgentLogger(`agent-${persona.name}`, persona.name, cfg.exchangeUrl, flag('quiet'));
  const market = new MarketClient(cfg.exchangeUrl, cfg.evmKey(), cfg.budgetAusd, persona, log);
  const wallet = Wallet.fromSeed(cfg.xrplSeed());
  const snap = await market.snapshot();
  log.thought(`market: ${snap.stats.providersVerified} verified data centers, ${snap.stats.slotsTotal - snap.stats.slotsBusy} free slots; budget ${formatUnits(cfg.budgetAusd, 6)} AUSD / ${formatUnits(cfg.budgetDrops, 6)} XRP`);
  if ((persona.finalAnswerRail === 'stream' || streamPrompt) && !jobs) await ensureFunded(wallet, 20);
  const deps: AgentDeps = { market, log, persona, model: cfg.model, effort: cfg.effort, exchangeUrl: cfg.exchangeUrl, wallet, issuer: snap.issuer, xrp: new XrpBudget(cfg.budgetDrops), genModel: cfg.genModel };

  const t0 = Date.now();
  const out = scripted ? await runScripted(deps, { question, indexUrl, jobs, stopAfterTokens, streamPrompt, streamMaxTokens }) : await runClaudeAgent(deps, { question, indexUrl, stopAfterTokens });

  console.log('\n' + '─'.repeat(72));
  if (out.answer) console.log(out.answer.trim());
  if (out.sources.length) console.log('\nSources:\n' + out.sources.map((s, i) => `  [${i + 1}] ${s}`).join('\n'));
  const b = market.budget();
  console.log('\nSpend report');
  console.log(`  jobs bought      ${market.jobsBought}`);
  console.log(`  AUSD settled     ${formatUnits(b.spent, 6, 4)} of ${formatUnits(b.budget, 6)}`);
  console.log(`  XRP authorized   ${formatUnits(deps.xrp.authorized, 6)} of ${formatUnits(deps.xrp.budget, 6)}${out.stream?.claimTx ? `  (claim https://testnet.xrpl.org/transactions/${out.stream.claimTx})` : ''}`);
  if (out.stream) {
    const s = out.stream;
    const expected = s.dropsPerToken * BigInt(s.tokens);
    console.log(`  stream           ${s.tokens} tokens × ${s.dropsPerToken} drops = ${expected} drops authorized${s.stopped ? ' (stopped early)' : ''}; provider ${s.providerName}; channel ${s.channelId.slice(0, 16)}…`);
    if (s.dropsPaid !== expected) console.log(`  !! drops authorized ${s.dropsPaid} != delivered × price ${expected}`);
  }
  console.log(`  elapsed          ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const r of market.receipts.slice(-5)) console.log(`  receipt          ${formatUnits(r.amount, 6, 4)} AUSD → ${r.payTo}  ${r.explorerUrl}`);
  await log.flush();
  await disconnectXrpl();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectXrpl().catch(() => undefined);
  process.exit(1);
});
