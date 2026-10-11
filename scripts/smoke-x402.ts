/**
 * End-to-end x402 on AUSD: in-process facilitator + a throwaway Express route priced at 0.01 AUSD,
 * payTo = the local provider. The agent wallet pays with the stock @x402/fetch client.
 * Passes when the response is 200 and Basescan shows AUSD moving agent → provider.
 */
import express from 'express';
import type { Server } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { loadEnv, REPO_ROOT, basescanTx, formatUnits } from '@idle/shared';
import { createAusdGate, createPaidFetch, ausdBalance, ethBalance } from '@idle/pay-evm';
import { createFacilitator } from '../apps/facilitator/src/app';
import { PROVIDER_ENV, readEnvValue, banner, ok, info, fail, assert } from './_lib';

loadEnv(REPO_ROOT);
const need = (k: string) => process.env[k] || fail(`${k} missing`);

const listen = (app: express.Express) =>
  new Promise<{ server: Server; port: number }>((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: (server.address() as { port: number }).port }));
  });

async function main() {
  banner('smoke: x402 + AUSD (Base Sepolia)');
  const PRICE = 10_000n; // 0.01 AUSD
  const providerPk = readEnvValue(PROVIDER_ENV, 'PROVIDER_EVM_PRIVATE_KEY') || fail('PROVIDER_EVM_PRIVATE_KEY missing');
  const provider = privateKeyToAccount(providerPk as `0x${string}`).address;
  const agentPk = need('AGENT_EVM_PRIVATE_KEY') as `0x${string}`;
  const agent = privateKeyToAccount(agentPk).address;

  const relayerEth = await ethBalance(privateKeyToAccount(need('FACILITATOR_PRIVATE_KEY') as `0x${string}`).address);
  const agentAusd = await ausdBalance(agent);
  info(`relayer ETH ${formatUnits(relayerEth, 18, 6)}   agent AUSD ${formatUnits(agentAusd, 6, 2)}   provider ${provider}`);
  if (relayerEth === 0n) fail('facilitator relayer has no ETH — run pnpm setup:fund');
  if (agentAusd < PRICE) fail('agent has no AUSD — run pnpm setup:fund');

  // facilitator
  const fac = createFacilitator(need('FACILITATOR_PRIVATE_KEY') as `0x${string}`);
  const f = await listen(fac.app);
  info(`facilitator on :${f.port} (relayer ${fac.address})`);

  // the same dynamic gate the exchange uses: price/payTo per request, settle only after the work passes
  const gate = createAusdGate({ routePattern: 'GET /paid', facilitatorUrl: `http://localhost:${f.port}` });
  await gate.initialize();
  const app = express();
  app.use(express.json());
  app.get('/paid', async (req, res) => {
    const g = await gate.check(req, res, { payTo: provider, amount: PRICE, body402: { error: 'PAYMENT_REQUIRED', quote: { quoteId: 'smoke-quote', payTo: provider, amount: PRICE.toString() } } });
    if (g.kind === 'responded') return;
    // "work" + verification happen here; then settle
    const settled = await g.settle();
    if (!settled.success) return res.status(502).json({ error: settled.reason, message: settled.message });
    res.json({ result: 'paid work', receipt: { txHash: settled.txHash, explorerUrl: settled.explorerUrl, payer: settled.payer } });
  });
  const s = await listen(app);
  const url = `http://localhost:${s.port}/paid`;

  // unpaid call → 402 with PAYMENT-REQUIRED header
  const unpaid = await fetch(url);
  assert(unpaid.status === 402, `expected 402, got ${unpaid.status}`);
  assert(unpaid.headers.get('PAYMENT-REQUIRED'), 'missing PAYMENT-REQUIRED header');
  const unpaidBody = (await unpaid.json()) as { quote?: { quoteId: string } };
  assert(unpaidBody.quote?.quoteId === 'smoke-quote', '402 body should carry the quote');
  ok('unpaid request → 402 with PAYMENT-REQUIRED header + quote in the JSON body');

  // paid call
  const before = await ausdBalance(provider);
  const { payFetch, tracker } = createPaidFetch({
    privateKey: agentPk,
    policy: { maxPerPayment: PRICE, budget: PRICE * 2n, isPayeeAllowed: (p) => p.toLowerCase() === provider.toLowerCase(), onSpend: (e) => info(`spend ${e.ok ? '✔' : '✘'} ${e.amount} → ${e.payTo} ${e.txHash ?? e.reason ?? ''}`) },
  });
  const t0 = Date.now();
  const r = await payFetch(url);
  const body = (await r.response.json()) as { receipt?: { txHash: string; explorerUrl: string } };
  assert(r.response.status === 200, `expected 200, got ${r.response.status}: ${JSON.stringify(body)}`);
  assert(r.settlement?.success && r.settlement.transaction, 'no settlement in PAYMENT-RESPONSE header');
  ok(`paid request → 200 in ${Date.now() - t0} ms; tx ${basescanTx(r.settlement!.transaction)}`);
  const after = await ausdBalance(provider);
  assert(after - before === PRICE, `provider AUSD delta ${after - before}, expected ${PRICE}`);
  ok(`provider received exactly ${formatUnits(PRICE, 6)} AUSD (agent → provider, gasless for the agent)`);
  info(`tracker: spent ${tracker.spent} / budget ${tracker.budget}`);

  // policy: a second call must be refused by the budget/payee policy? budget allows 2; test payee allow-list instead
  const { payFetch: strict } = createPaidFetch({ privateKey: agentPk, policy: { maxPerPayment: PRICE, budget: PRICE, isPayeeAllowed: () => false } });
  const refused = await strict(url);
  assert(!refused.paid && refused.abortReason, 'policy should have refused the payee');
  ok(`spending policy refused a disallowed payee before signing (${refused.abortReason})`);

  s.server.close();
  f.server.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
