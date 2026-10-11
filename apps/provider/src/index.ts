import { loadConfig } from './config';
import { createLogger } from './log';
import { ensureWallets, fundXrplIfNeeded } from './wallets';
import { detectHardware } from './hardware';
import { Ollama } from './ollama';
import { DEFAULT_BENCHMARK, probeEmbedding, probeGeneration, runBenchmark } from './benchmark';
import { ExchangeConnection } from './connection';
import { ProviderDaemon } from './daemon';

const log = createLogger('provider');

async function main() {
  const cfg = loadConfig();
  log.info(`Idle data-center daemon — ${cfg.name} (${cfg.region}), ${cfg.slots} slot(s)${cfg.cheat ? ', CHEAT MODE' : ''}`);
  const wallets = ensureWallets(log);
  log.info(`EVM payout ${wallets.evmAddress} · XRPL ${wallets.xrpl.address}`);
  log.info(`floors: embed ${cfg.floors.embed} µAUSD/text · generate ${cfg.floors.generate} µAUSD/token · stream ${cfg.floors.streamDrops} drops/token`);

  const hardware = await detectHardware();
  log.info(`hardware: ${hardware.label}`);

  const ollama = new Ollama(cfg.ollamaUrl);
  const tags = await ollama.tags().catch((e) => {
    log.error(`Ollama not reachable at ${cfg.ollamaUrl}: ${(e as Error).message}`);
    process.exit(1);
  });
  for (const m of [cfg.embedModel, cfg.genModel]) {
    if (!tags.some((t) => t === m || t === `${m}:latest`)) log.warn(`model ${m} not found in Ollama (have: ${tags.join(', ')}); run \`ollama pull ${m}\``);
  }

  await fundXrplIfNeeded(wallets.xrpl, log);

  const embedNumGpu = await probeEmbedding(ollama, cfg.embedModel, log, cfg.embedDevice);
  const genNumGpu = await probeGeneration(ollama, cfg.genModel, log, cfg.genDevice);
  const benchmark = cfg.benchmark ? await runBenchmark(ollama, { ...cfg, genNumGpu, embedNumGpu }, log) : { ...DEFAULT_BENCHMARK, embedDim: 768 };

  const conn = new ExchangeConnection(cfg.exchangeUrl, log);
  const daemon = new ProviderDaemon({ cfg, wallets, hardware, benchmark, ollama, conn, log, genNumGpu, embedNumGpu });
  daemon.onDrained = (reason) => {
    log.info(`offline (${reason})`);
    process.exit(0);
  };
  daemon.start();

  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) {
      log.warn('forced exit');
      process.exit(130);
    }
    stopping = true;
    daemon.drain(sig).then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error((e as Error).stack ?? String(e));
  process.exit(1);
});
