/** Buyer opens a 5 XRP channel → signs a 0.25 XRP claim → provider verifies → submits PaymentChannelClaim → balance up. */
import { loadEnv, REPO_ROOT, xrplTx, formatUnits } from '@idle/shared';
import { Wallet } from 'xrpl';
import { ensureFunded, openChannel, getChannel, signClaim, verifyClaim, submitClaim, getXrpBalanceDrops, disconnectXrpl } from '@idle/pay-xrpl';
import { PROVIDER_ENV, readEnvValue, banner, ok, info, fail, assert } from './_lib';

loadEnv(REPO_ROOT);

async function main() {
  banner('smoke: XRPL Payment Channel');
  const buyer = Wallet.fromSeed(process.env.AGENT_XRPL_SEED || fail('AGENT_XRPL_SEED missing'));
  const provider = Wallet.fromSeed(readEnvValue(PROVIDER_ENV, 'PROVIDER_XRPL_SEED') || fail('PROVIDER_XRPL_SEED missing in apps/provider/.env.local'));
  await Promise.all([ensureFunded(buyer), ensureFunded(provider)]);

  const { channelId, txHash } = await openChannel(buyer, provider.address, 5_000_000n, 60);
  ok(`PaymentChannelCreate ${xrplTx(txHash)}`);
  info(`channel ${channelId}`);
  const ch = await getChannel(channelId);
  assert(ch && ch.destination === provider.address && ch.amountDrops === 5_000_000n, 'channel not found / wrong fields');

  const claimDrops = 250_000n;
  const sig = signClaim(buyer, channelId, claimDrops);
  assert(verifyClaim(channelId, claimDrops, sig, buyer.publicKey), 'provider failed to verify the claim');
  assert(!verifyClaim(channelId, claimDrops + 1n, sig, buyer.publicKey), 'claim verified for the wrong amount');
  ok('off-ledger claim signed by buyer and verified by provider (drops exact)');

  const before = await getXrpBalanceDrops(provider.address);
  const claim = await submitClaim(provider, channelId, claimDrops, sig, buyer.publicKey);
  ok(`PaymentChannelClaim ${xrplTx(claim.txHash)}`);
  const after = await getXrpBalanceDrops(provider.address);
  const delta = after - before;
  info(`provider balance ${formatUnits(before, 6)} → ${formatUnits(after, 6)} XRP (Δ ${delta} drops incl. fee)`);
  assert(delta > claimDrops - 20_000n, 'provider balance did not increase by the claim');
  const ch2 = await getChannel(channelId);
  assert(ch2 && ch2.balanceDrops === claimDrops, `on-ledger Balance should equal ${claimDrops}, got ${ch2?.balanceDrops}`);
  ok(`on-ledger channel Balance == ${claimDrops} drops exactly`);
  await disconnectXrpl();
}
main().catch(async (e) => {
  console.error(e);
  await disconnectXrpl();
  process.exit(1);
});
