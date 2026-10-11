/**
 * Funds everything that can be funded automatically and tells you exactly what you must do by hand.
 *  - XRPL: testnet faucet for the exchange issuer, the agent and the local provider.
 *  - EVM: prints the addresses that need a dust amount of Base Sepolia ETH and polls until they have it.
 *  - AUSD: calls the faucet for the agent wallet.
 */
import { loadEnv, REPO_ROOT, formatUnits, basescanAddress, xrplAccount, basescanTx } from '@idle/shared';
import { Wallet } from 'xrpl';
import { ensureFunded, getXrpBalanceDrops, disconnectXrpl } from '@idle/pay-xrpl';
import { ethBalance, ausdBalance, requestAusdFromFaucet, getWalletClient, ausdDomainFromEnv } from '@idle/pay-evm';
import { privateKeyToAccount } from 'viem/accounts';
import { PROVIDER_ENV, readEnvValue, banner, ok, info, fail, sleep, hasFlag } from './_lib';

loadEnv(REPO_ROOT);

const MIN_RELAYER_ETH = 10n ** 14n; // 0.0001 ETH ≈ a few hundred settlements at Base Sepolia gas prices (one faucet claim is enough)
const MIN_AGENT_ETH = 10n ** 13n; // 0.00001 ETH — only for one AUSD faucet call
const AGENT_TOPUP_ETH = 3n * 10n ** 13n; // what the relayer forwards to the agent if the agent has nothing
const MIN_AGENT_AUSD = 1_000n * 10n ** 6n;

const need = (k: string) => process.env[k] || fail(`${k} missing — run pnpm setup:wallets`);

async function main() {
  banner('XRPL testnet funding');
  const xrplWallets: Array<[string, Wallet]> = [
    ['exchange issuer', Wallet.fromSeed(need('EXCHANGE_XRPL_SEED'))],
    ['agent', Wallet.fromSeed(need('AGENT_XRPL_SEED'))],
  ];
  const provSeed = readEnvValue(PROVIDER_ENV, 'PROVIDER_XRPL_SEED');
  if (provSeed) xrplWallets.push(['local provider', Wallet.fromSeed(provSeed)]);
  for (const [role, w] of xrplWallets) {
    const before = await getXrpBalanceDrops(w.address);
    const after = await ensureFunded(w, 20);
    info(`${role.padEnd(16)} ${w.address}  ${formatUnits(after, 6)} XRP${after > before ? '  (funded)' : ''}  ${xrplAccount(w.address)}`);
  }
  ok('XRPL accounts funded');

  banner('Base Sepolia ETH (manual step)');
  const relayer = privateKeyToAccount(need('FACILITATOR_PRIVATE_KEY') as `0x${string}`).address;
  const agent = privateKeyToAccount(need('AGENT_EVM_PRIVATE_KEY') as `0x${string}`).address;
  const targets: Array<[string, `0x${string}`, bigint]> = [
    ['facilitator relayer', relayer, MIN_RELAYER_ETH],
    ['agent wallet', agent, MIN_AGENT_ETH],
  ];
  const report = async () => {
    const missing: typeof targets = [];
    for (const t of targets) {
      const bal = await ethBalance(t[1]);
      const okk = bal >= t[2];
      info(`${okk ? '✔' : '✘'} ${t[0].padEnd(20)} ${t[1]}  ${formatUnits(bal, 18, 6)} ETH (need ≥ ${formatUnits(t[2], 18, 6)})`);
      if (!okk) missing.push(t);
    }
    return missing;
  };
  let missing = await report();
  // Only the relayer needs a faucet claim: it forwards a sliver to the agent wallet for its one faucet call.
  const forwardToAgent = async () => {
    const [r, a] = await Promise.all([ethBalance(relayer), ethBalance(agent)]);
    if (a >= MIN_AGENT_ETH || r < MIN_RELAYER_ETH + AGENT_TOPUP_ETH) return false;
    info(`relayer forwards ${formatUnits(AGENT_TOPUP_ETH, 18, 6)} ETH to the agent wallet for its faucet call …`);
    const w = getWalletClient(need('FACILITATOR_PRIVATE_KEY') as `0x${string}`);
    const hash = await w.sendTransaction({ to: agent, value: AGENT_TOPUP_ETH });
    await w.waitForTransactionReceipt({ hash });
    info(`forwarded  ${basescanTx(hash)}`);
    return true;
  };
  if (missing.length && (await forwardToAgent())) missing = await report();
  if (missing.length) {
    console.log('\n  Send a little Base Sepolia ETH to the RELAYER (the agent gets topped up from it automatically), e.g. from:');
    console.log('    https://portal.cdp.coinbase.com/products/faucet   (Base Sepolia)');
    console.log('    https://www.alchemy.com/faucets/base-sepolia');
    console.log('  Any faucet drip (0.001+ ETH) is enough. Gas here is ~0.006 gwei.');
    for (const t of missing) console.log(`    ${t[0]}: ${t[1]}  ${basescanAddress(t[1])}`);
    if (hasFlag('no-wait')) {
      console.log('\n  --no-wait given; re-run pnpm setup:fund once funded.');
      await disconnectXrpl();
      process.exit(2);
    }
    console.log('\n  Waiting for funds (polling every 10s, up to 30 min)...');
    const deadline = Date.now() + 30 * 60_000;
    while (missing.length && Date.now() < deadline) {
      await sleep(10_000);
      missing = await report();
      if (missing.length && (await forwardToAgent())) missing = await report();
    }
    if (missing.length) fail('still unfunded; re-run pnpm setup:fund when done');
  }
  ok('EVM gas wallets funded');

  banner('AUSD faucet');
  ausdDomainFromEnv();
  const bal = await ausdBalance(agent);
  if (bal >= MIN_AGENT_AUSD) {
    info(`agent already holds ${formatUnits(bal, 6, 2)} AUSD`);
  } else {
    info('calling faucet.requestFunds(agent) ...');
    const hash = await requestAusdFromFaucet(getWalletClient(need('AGENT_EVM_PRIVATE_KEY') as `0x${string}`), agent);
    const after = await ausdBalance(agent);
    info(`agent now holds ${formatUnits(after, 6, 2)} AUSD  ${basescanTx(hash)}`);
  }
  ok('funding complete');
  await disconnectXrpl();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
