import { convertStringToHex, rippleTimeToUnixTime, unixTimeToRippleTime } from 'xrpl';
import type { CredentialAccept, CredentialCreate, CredentialDelete, Wallet } from 'xrpl';
import { getXrplClient } from './client';
import { submitTx } from './queue';

/** lsfAccepted on a Credential ledger entry. */
export const LSF_ACCEPTED = 0x00010000;

export const credentialTypeHex = (type: string): string => convertStringToHex(type).toUpperCase();

export interface CredentialLookup {
  exists: boolean;
  accepted: boolean;
  expired: boolean;
  expiration?: number; // ripple epoch seconds
  index?: string;
  issuer?: string;
  subject?: string;
}

export async function createCredential(
  issuer: Wallet,
  subject: string,
  type: string,
  opts: { uri?: string; expiresInMs?: number } = {},
): Promise<{ txHash: string }> {
  const tx: CredentialCreate = {
    TransactionType: 'CredentialCreate',
    Account: issuer.address,
    Subject: subject,
    CredentialType: credentialTypeHex(type),
  };
  if (opts.uri) tx.URI = convertStringToHex(opts.uri).toUpperCase();
  if (opts.expiresInMs) tx.Expiration = unixTimeToRippleTime(Date.now() + opts.expiresInMs);
  const res = await submitTx(issuer, tx);
  return { txHash: res.result.hash };
}

export async function acceptCredential(subject: Wallet, issuer: string, type: string): Promise<{ txHash: string }> {
  const tx: CredentialAccept = {
    TransactionType: 'CredentialAccept',
    Account: subject.address,
    Issuer: issuer,
    CredentialType: credentialTypeHex(type),
  };
  const res = await submitTx(subject, tx);
  return { txHash: res.result.hash };
}

/** Issuer-side revocation. The ledger entry disappears immediately. */
export async function deleteCredential(issuer: Wallet, subject: string, type: string): Promise<{ txHash: string }> {
  const tx: CredentialDelete = {
    TransactionType: 'CredentialDelete',
    Account: issuer.address,
    Subject: subject,
    CredentialType: credentialTypeHex(type),
  };
  const res = await submitTx(issuer, tx);
  return { txHash: res.result.hash };
}

/** Reads the credential straight from the validated ledger. */
export async function lookupCredential(subject: string, issuer: string, type: string): Promise<CredentialLookup> {
  const client = await getXrplClient();
  const credential_type = credentialTypeHex(type);
  const ask = (key: 'credential_type' | 'credentialType') =>
    client.request({
      command: 'ledger_entry',
      ledger_index: 'validated',
      credential: { subject, issuer, [key]: credential_type },
    } as never);
  let res;
  try {
    res = await ask('credential_type');
  } catch (e: unknown) {
    const err = e as { data?: { error?: string }; message?: string };
    const code = err.data?.error ?? err.message ?? '';
    if (/entryNotFound/.test(code)) return { exists: false, accepted: false, expired: false };
    if (/invalidParams|malformed/i.test(code)) {
      try {
        res = await ask('credentialType');
      } catch (e2: unknown) {
        const code2 = (e2 as { data?: { error?: string } }).data?.error ?? (e2 as Error).message ?? '';
        if (/entryNotFound/.test(code2)) return { exists: false, accepted: false, expired: false };
        throw e2;
      }
    } else {
      throw e;
    }
  }
  const node = (res as { result: { node?: Record<string, unknown>; index?: string } }).result.node;
  if (!node) return { exists: false, accepted: false, expired: false };
  const flags = Number(node.Flags ?? 0);
  const expiration = typeof node.Expiration === 'number' ? node.Expiration : undefined;
  const expired = expiration !== undefined && rippleTimeToUnixTime(expiration) <= Date.now();
  return {
    exists: true,
    accepted: (flags & LSF_ACCEPTED) !== 0,
    expired,
    expiration,
    index: (res as { result: { index?: string } }).result.index,
    issuer: String(node.Issuer),
    subject: String(node.Subject),
  };
}

const cache = new Map<string, { at: number; ok: boolean }>();

/**
 * Buyer-side trustless check: does `subject` hold an accepted, unexpired credential from `issuer`?
 * Reads the ledger directly; cached for `cacheMs`.
 */
export async function hasValidCredential(
  subject: string,
  issuer: string,
  type: string,
  cacheMs = 60_000,
): Promise<boolean> {
  const key = `${subject}|${issuer}|${type}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cacheMs) return hit.ok;
  const c = await lookupCredential(subject, issuer, type);
  const ok = c.exists && c.accepted && !c.expired;
  cache.set(key, { at: Date.now(), ok });
  return ok;
}

export function invalidateCredentialCache(subject?: string): void {
  if (!subject) return cache.clear();
  for (const k of cache.keys()) if (k.startsWith(subject + '|')) cache.delete(k);
}
