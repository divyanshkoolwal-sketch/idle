import { privateKeyToAccount, generatePrivateKey } from '@idle/pay-evm';
import { walletFromSeed, generateWallet, ensureFunded } from '@idle/pay-xrpl';
import type { Wallet } from 'xrpl';
import { ENV_LOCAL } from './config';
import { readEnvValue, upsertEnv } from './envfile';
import type { Logger } from './log';

export interface ProviderWallets {
  evmAddress: `0x${string}`;
  xrpl: Wallet;
}

/**
 * Loads PROVIDER_EVM_PRIVATE_KEY / PROVIDER_XRPL_SEED from the environment (root .env then apps/provider/.env.local).
 * Missing keys are generated and appended to .env.local so a fresh laptop can join with one command.
 * Existing values are never overwritten.
 */
export function ensureWallets(log: Logger): ProviderWallets {
  let evmKey = process.env.PROVIDER_EVM_PRIVATE_KEY ?? readEnvValue(ENV_LOCAL, 'PROVIDER_EVM_PRIVATE_KEY');
  if (!evmKey) {
    evmKey = generatePrivateKey();
    upsertEnv(ENV_LOCAL, 'PROVIDER_EVM_PRIVATE_KEY', evmKey);
    log.info('generated PROVIDER_EVM_PRIVATE_KEY → apps/provider/.env.local');
  }
  let seed = process.env.PROVIDER_XRPL_SEED ?? readEnvValue(ENV_LOCAL, 'PROVIDER_XRPL_SEED');
  if (!seed) {
    const w = generateWallet();
    seed = w.seed!;
    upsertEnv(ENV_LOCAL, 'PROVIDER_XRPL_SEED', seed);
    log.info('generated PROVIDER_XRPL_SEED → apps/provider/.env.local');
  }
  return { evmAddress: privateKeyToAccount(evmKey as `0x${string}`).address, xrpl: walletFromSeed(seed) };
}

/** Funds the XRPL account from the testnet faucet if needed; never blocks startup for more than `timeoutMs`. */
export async function fundXrplIfNeeded(wallet: Wallet, log: Logger, timeoutMs = 60_000): Promise<void> {
  const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs));
  try {
    const res = await Promise.race([ensureFunded(wallet, 20), timeout]);
    if (res === 'timeout') log.warn('XRPL faucet slow; continuing without confirmation of funding');
    else log.info(`XRPL ${wallet.address} balance ${(Number(res) / 1e6).toFixed(2)} XRP`);
  } catch (e) {
    log.warn(`XRPL funding check failed (non-fatal): ${(e as Error).message}`);
  }
}

export function readProviderId(): string | undefined {
  return process.env.PROVIDER_ID ?? readEnvValue(ENV_LOCAL, 'PROVIDER_ID');
}
export function saveProviderId(id: string): void {
  process.env.PROVIDER_ID = id;
  if (process.env.PROVIDER_PERSIST_ID === '0') return; // tests
  upsertEnv(ENV_LOCAL, 'PROVIDER_ID', id);
}
