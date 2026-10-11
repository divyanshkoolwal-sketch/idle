import { Wallet } from 'xrpl';
import { getXrplClient } from './client';

export const walletFromSeed = (seed: string): Wallet => Wallet.fromSeed(seed);

/** New ed25519 wallet. Seed starts with "sEd", so Wallet.fromSeed infers the algorithm. */
export const generateWallet = (): Wallet => Wallet.generate();

export async function getXrpBalanceDrops(address: string): Promise<bigint> {
  const client = await getXrplClient();
  try {
    const res = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' });
    return BigInt(res.result.account_data.Balance);
  } catch (e: unknown) {
    const msg = (e as { data?: { error?: string }; message?: string }).data?.error ?? (e as Error).message ?? '';
    if (/actNotFound/.test(msg)) return 0n;
    throw e;
  }
}

/** Funds the wallet from the testnet faucet if its balance is below `minXrp`. Returns the balance in drops. */
export async function ensureFunded(wallet: Wallet, minXrp = 20): Promise<bigint> {
  const before = await getXrpBalanceDrops(wallet.address);
  if (before >= BigInt(minXrp) * 1_000_000n) return before;
  const client = await getXrplClient();
  await client.fundWallet(wallet);
  // fundWallet resolves when the faucet payment is visible; re-read to be sure.
  for (let i = 0; i < 10; i++) {
    const bal = await getXrpBalanceDrops(wallet.address);
    if (bal > before) return bal;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return getXrpBalanceDrops(wallet.address);
}
