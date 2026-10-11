/**
 * Reads AUSD's EIP-712 domain on-chain, proves it against DOMAIN_SEPARATOR(), records decimals and
 * which transferWithAuthorization overloads the implementation exposes, and writes the results to .env.
 */
import { loadEnv, REPO_ROOT } from '@idle/shared';
import { loadAusdDomain, detectErc3009Overloads, ausdAddress } from '@idle/pay-evm';
import { ROOT_ENV, upsertEnv, banner, ok, info, fail, ensureEnvFiles } from './_lib';

ensureEnvFiles();
loadEnv(REPO_ROOT);

async function main() {
  banner(`AUSD @ ${ausdAddress()} (Base Sepolia)`);
  const d = await loadAusdDomain();
  info(`source            ${d.source}`);
  info(`name              "${d.name}"`);
  info(`version           "${d.version}"`);
  info(`decimals          ${d.decimals}`);
  info(`DOMAIN_SEPARATOR  ${d.onChainSeparator}`);
  info(`computed          ${d.computedSeparator}`);
  if (!d.verified) fail('computed domain separator does not match on-chain value');
  ok('EIP-712 domain verified against on-chain DOMAIN_SEPARATOR()');

  upsertEnv(ROOT_ENV, 'AUSD_EIP712_NAME', d.name, true);
  upsertEnv(ROOT_ENV, 'AUSD_EIP712_VERSION', d.version, true);
  upsertEnv(ROOT_ENV, 'AUSD_DECIMALS', String(d.decimals), true);
  ok('wrote AUSD_EIP712_NAME / AUSD_EIP712_VERSION / AUSD_DECIMALS to .env');

  const o = await detectErc3009Overloads();
  banner('ERC-3009 overloads (from implementation bytecode)');
  info(`implementation                        ${o.implementation ?? '(not a proxy)'}`);
  info(`transferWithAuthorization(bytes sig)  ${o.transferWithAuthorization.bytes ? 'yes' : 'no'}`);
  info(`transferWithAuthorization(v,r,s)      ${o.transferWithAuthorization.vrs ? 'yes' : 'no'}`);
  info(`receiveWithAuthorization(bytes sig)   ${o.receiveWithAuthorization.bytes ? 'yes' : 'no'}`);
  info(`receiveWithAuthorization(v,r,s)       ${o.receiveWithAuthorization.vrs ? 'yes' : 'no'}`);
  if (!o.transferWithAuthorization.bytes && !o.transferWithAuthorization.vrs) fail('no transferWithAuthorization overload found');
  upsertEnv(ROOT_ENV, 'AUSD_TWA_BYTES_OVERLOAD', String(o.transferWithAuthorization.bytes), true);
  ok('done');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
