/**
 * End-to-end x402 on AUSD: in-process facilitator + a throwaway Express route priced at 0.01 AUSD,
 * payTo = the local provider. The agent wallet pays with the stock @x402/fetch client.
 * Passes when the response is 200 and Basescan shows AUSD moving agent → provider.
 */
import express from 'express';
import type { Server } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { loadEnv, REPO_ROOT, basescanTx, formatUnits } from '@idle/shared';
import { createResourceServer, ausdPaymentOption, x402HTTPResourceServer, requestContext, createPaidFetch, ausdBalance, ethBalance } from '@idle/pay-evm';
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

  // resource server with a dynamic-capable route, static here
  const resource = createResourceServer(`http://localhost:${f.port}`);
  const routes = { 'GET /paid': { accepts: ausdPaymentOption({ payTo: provider, amount: PRICE }), description: 'smoke test resource' } };
  const httpServer = new x402HTTPResourceServer(resource, routes);
  await httpServer.initialize();
  const app = express();
  app.use(express.json());
  app.get('/paid', async (req, res) => {
    const ctx = requestContext(req);
    const r = await httpServer.processHTTPRequest(ctx);
    if (r.type === 'payment-error') {
      res.status(r.response.status);
      for (const [k, v] of Object.entries(r.response.headers)) res.setHeader(k, v);
      return res.json({ ...(r.response.body as object), quoteId: 'smoke-quote' });
    }
    if (r.type === 'no-payment-required') return res.json({ free: true });
    // verified: do the "work", then settle (settle-after-verify)
    const settle = await httpServer.processSettlement(r.paymentPayload, r.paymentRequirements, r.declaredExtensions, { request: ctx });
    if (!settle.success) {
      res.status(settle.response.status);
      for (const [k, v] of Object.entries(settle.response.headers)) res.setHeader(k, v);
      return res.json(settle.response.body ?? { error: settle.errorReason });
    }
    for (const [k, v] of Object.entries(settle.headers)) res.setHeader(k, v);
    res.json({ result: 'paid work', receipt: { txHash: settle.transaction, explorerUrl: basescanTx(settle.transaction), payer: settle.payer } });
  });
  const s = await listen(app);
  const url = `http://localhost:${s.port}/paid`;

  // unpaid call → 402 with PAYMENT-REQUIRED header
  const unpaid = await fetch(url);
  assert(unpaid.status === 402, `expected 402, got ${unpaid.status}`);
  assert(unpaid.headers.get('PAYMENT-REQUIRED'), 'missing PAYMENT-REQUIRED header');
  ok('unpaid request → 402 with PAYMENT-REQUIRED header');

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
