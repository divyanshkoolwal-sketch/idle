/**
 * Generates any missing keys/seeds into the right gitignored env files and prints all addresses.
 * Never overwrites an existing value.
 */
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Wallet } from 'xrpl';
import { ROOT_ENV, PROVIDER_ENV, ensureEnvFiles, readEnvValue, upsertEnv, banner, ok, info, rel } from './_lib';

ensureEnvFiles();

type Row = { role: string; file: string; key: string; address: string; created: boolean };
const rows: Row[] = [];

function ensure(file: string, key: string, role: string, make: () => { secret: string; address: string }, derive: (secret: string) => string) {
  const existing = readEnvValue(file, key);
  if (existing) {
    rows.push({ role, file, key, address: derive(existing), created: false });
    return;
  }
  const { secret, address } = make();
  upsertEnv(file, key, secret);
  rows.push({ role, file, key, address, created: true });
}

const evm = () => {
  const pk = generatePrivateKey();
  return { secret: pk, address: privateKeyToAccount(pk).address };
};
const evmAddr = (pk: string) => privateKeyToAccount(pk as `0x${string}`).address;
const xrpl = () => {
  const w = Wallet.generate();
  return { secret: w.seed!, address: w.address };
};
const xrplAddr = (seed: string) => Wallet.fromSeed(seed).address;

banner('EVM keys (Base Sepolia)');
ensure(ROOT_ENV, 'FACILITATOR_PRIVATE_KEY', 'facilitator relayer (pays gas)', evm, evmAddr);
ensure(ROOT_ENV, 'AGENT_EVM_PRIVATE_KEY', 'buyer agent (holds AUSD)', evm, evmAddr);
ensure(PROVIDER_ENV, 'PROVIDER_EVM_PRIVATE_KEY', 'local provider (receive-only)', evm, evmAddr);

banner('XRPL seeds (testnet)');
ensure(ROOT_ENV, 'EXCHANGE_XRPL_SEED', 'exchange / credential issuer', xrpl, xrplAddr);
ensure(ROOT_ENV, 'AGENT_XRPL_SEED', 'buyer agent (pays channels)', xrpl, xrplAddr);
ensure(PROVIDER_ENV, 'PROVIDER_XRPL_SEED', 'local provider (channel payee)', xrpl, xrplAddr);

if (!readEnvValue(ROOT_ENV, 'ADMIN_TOKEN')) {
  upsertEnv(ROOT_ENV, 'ADMIN_TOKEN', randomBytes(16).toString('hex'));
  ok('ADMIN_TOKEN generated');
}

banner('Addresses');
for (const r of rows) {
  info(`${r.created ? 'NEW ' : 'kept'}  ${r.role.padEnd(32)} ${r.address}   (${r.key} in ${rel(r.file)})`);
}
ok('wallets ready. Next: pnpm setup:fund');
