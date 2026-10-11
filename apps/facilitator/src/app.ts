import express from 'express';
import type { Hex } from 'viem';
import { x402Facilitator } from '@x402/core/facilitator';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { getWalletClient } from '@idle/pay-evm';
import { BASE_SEPOLIA_CAIP2, basescanTx } from '@idle/shared';
import { ausdAddress } from '@idle/pay-evm';

/**
 * Self-hosted x402 facilitator for AUSD on Base Sepolia.
 * The relayer wallet pays gas for every transferWithAuthorization.
 * Settlements run through a concurrency-1 queue (plus viem's nonceManager) so parallel jobs never collide on nonces.
 */
export function createFacilitator(privateKey: Hex, opts: { log?: (msg: string) => void } = {}) {
  const log = opts.log ?? ((m: string) => console.log(`[facilitator] ${m}`));
  const wallet = getWalletClient(privateKey, { managedNonce: true });
  const address = wallet.account.address;
  const signer = toFacilitatorEvmSigner({ ...wallet, address } as never, { confirmationTimeoutMs: 90_000 });

  const facilitator = new x402Facilitator();
  registerExactEvmScheme(facilitator, { signer, networks: BASE_SEPOLIA_CAIP2 });

  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.catch(() => undefined).then(fn);
    chain = p;
    return p;
  };

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, relayer: address, network: BASE_SEPOLIA_CAIP2 }));
  app.get('/supported', (_req, res) => res.json(facilitator.getSupported()));

  /** Only AUSD on Base Sepolia: the relayer never sends gas to arbitrary contracts. */
  const pinned = (pr: { asset?: string; network?: string; scheme?: string } | undefined): string | null => {
    if (!pr) return 'missing paymentRequirements';
    if (pr.scheme !== 'exact') return 'scheme must be exact';
    if (pr.network !== BASE_SEPOLIA_CAIP2) return `network must be ${BASE_SEPOLIA_CAIP2}`;
    if ((pr.asset ?? '').toLowerCase() !== ausdAddress().toLowerCase()) return 'asset must be AUSD';
    return null;
  };

  app.post('/verify', async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({ isValid: false, invalidReason: 'bad_request', invalidMessage: 'paymentPayload and paymentRequirements required' });
    }
    const pin = pinned(paymentRequirements);
    if (pin) return res.json({ isValid: false, invalidReason: 'unsupported_requirements', invalidMessage: pin });
    try {
      const result = await facilitator.verify(paymentPayload, paymentRequirements);
      if (!result.isValid) log(`verify ✘ ${result.invalidReason ?? ''} ${result.invalidMessage ?? ''}`);
      res.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`verify exception: ${msg}`);
      res.json({ isValid: false, invalidReason: 'verify_exception', invalidMessage: 'verification failed' });
    }
  });

  app.post('/settle', async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({ success: false, errorReason: 'bad_request', transaction: '', network: BASE_SEPOLIA_CAIP2 });
    }
    const pin = pinned(paymentRequirements);
    if (pin) return res.json({ success: false, errorReason: 'unsupported_requirements', errorMessage: pin, transaction: '', network: BASE_SEPOLIA_CAIP2 });
    try {
      const result = await enqueue(() => facilitator.settle(paymentPayload, paymentRequirements));
      if (result.success) log(`settled ${paymentRequirements.amount} → ${paymentRequirements.payTo} ${basescanTx(result.transaction)}`);
      else log(`settle ✘ ${result.errorReason ?? ''} ${result.errorMessage ?? ''}`);
      res.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`settle exception: ${msg}`);
      res.json({ success: false, errorReason: 'settle_exception', errorMessage: 'settlement failed', transaction: '', network: BASE_SEPOLIA_CAIP2 });
    }
  });

  return { app, facilitator, address, wallet };
}
