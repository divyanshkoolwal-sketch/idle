/** Issuer creates IDLE_DC_TIER_A for a subject → subject accepts → ledger shows lsfAccepted → issuer deletes. */
import { loadEnv, REPO_ROOT, xrplTx, xrplAccount } from '@idle/shared';
import { Wallet } from 'xrpl';
import { ensureFunded, createCredential, acceptCredential, deleteCredential, lookupCredential, hasValidCredential, invalidateCredentialCache, disconnectXrpl } from '@idle/pay-xrpl';
import { PROVIDER_ENV, readEnvValue, banner, ok, info, fail, assert } from './_lib';

loadEnv(REPO_ROOT);
const TYPE = 'IDLE_DC_TIER_A';

async function main() {
  banner('smoke: XRPL Credentials');
  const issuer = Wallet.fromSeed(process.env.EXCHANGE_XRPL_SEED || fail('EXCHANGE_XRPL_SEED missing'));
  const subjectSeed = readEnvValue(PROVIDER_ENV, 'PROVIDER_XRPL_SEED') ?? process.env.AGENT_XRPL_SEED ?? fail('no subject seed');
  const subject = Wallet.fromSeed(subjectSeed);
  await Promise.all([ensureFunded(issuer), ensureFunded(subject)]);
  info(`issuer  ${issuer.address}  ${xrplAccount(issuer.address)}`);
  info(`subject ${subject.address}  ${xrplAccount(subject.address)}`);

  // clean slate if a previous run left one behind
  const pre = await lookupCredential(subject.address, issuer.address, TYPE);
  if (pre.exists) {
    info('deleting leftover credential first');
    await deleteCredential(issuer, subject.address, TYPE);
  }

  const c = await createCredential(issuer, subject.address, TYPE, { uri: 'http://localhost:8080/providers/smoke', expiresInMs: 24 * 3600_000 });
  ok(`CredentialCreate  ${xrplTx(c.txHash)}`);
  let l = await lookupCredential(subject.address, issuer.address, TYPE);
  assert(l.exists && !l.accepted, `expected unaccepted credential on ledger, got ${JSON.stringify(l)}`);
  info(`ledger_entry: exists=${l.exists} accepted=${l.accepted} expiration=${l.expiration}`);

  const a = await acceptCredential(subject, issuer.address, TYPE);
  ok(`CredentialAccept  ${xrplTx(a.txHash)}`);
  l = await lookupCredential(subject.address, issuer.address, TYPE);
  assert(l.exists && l.accepted, `expected lsfAccepted set, got ${JSON.stringify(l)}`);
  invalidateCredentialCache();
  assert(await hasValidCredential(subject.address, issuer.address, TYPE), 'hasValidCredential should be true');
  info('ledger_entry: lsfAccepted = true; hasValidCredential = true');

  const d = await deleteCredential(issuer, subject.address, TYPE);
  ok(`CredentialDelete  ${xrplTx(d.txHash)}`);
  l = await lookupCredential(subject.address, issuer.address, TYPE);
  assert(!l.exists, 'credential should be gone');
  invalidateCredentialCache();
  assert(!(await hasValidCredential(subject.address, issuer.address, TYPE)), 'hasValidCredential should be false after delete');
  ok('credential lifecycle verified on-ledger');
  await disconnectXrpl();
}
main().catch(async (e) => {
  console.error(e);
  await disconnectXrpl();
  process.exit(1);
});
