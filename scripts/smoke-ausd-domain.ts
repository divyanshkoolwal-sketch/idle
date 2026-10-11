import { loadEnv, REPO_ROOT } from '@idle/shared';
import { loadAusdDomain, ausdDomainFromEnv } from '@idle/pay-evm';
import { banner, ok, info, fail } from './_lib';

loadEnv(REPO_ROOT);
banner('smoke: AUSD EIP-712 domain');
const envDomain = ausdDomainFromEnv();
const d = await loadAusdDomain();
info(`on-chain  name="${d.name}" version="${d.version}" decimals=${d.decimals}`);
info(`.env      name="${envDomain.name}" version="${envDomain.version}" decimals=${envDomain.decimals}`);
if (!d.verified) fail('domain separator mismatch');
if (d.name !== envDomain.name || d.version !== envDomain.version || d.decimals !== envDomain.decimals) fail('.env domain differs from chain — run pnpm setup:ausd-domain');
ok(`domain separator matches on-chain: ${d.onChainSeparator}`);
