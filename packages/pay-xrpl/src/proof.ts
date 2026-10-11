/**
 * Proof of XRPL key possession for provider `hello` (prevents impersonating another data center's
 * XRPL address / redirecting its payouts). Signs a canonical message with the account's key.
 */
import { randomBytes } from 'node:crypto';
import { sign, verify, deriveAddress } from 'ripple-keypairs';
import { convertStringToHex } from 'xrpl';
import type { Wallet } from 'xrpl';

export interface HelloProof {
  ts: number;
  nonce: string;
  signature: string;
}

const message = (f: { xrplAddress: string; evmAddress: string; ts: number; nonce: string }) =>
  convertStringToHex(`idle-hello|${f.xrplAddress}|${f.evmAddress.toLowerCase()}|${f.ts}|${f.nonce}`);

export function signHelloProof(wallet: Wallet, evmAddress: string): HelloProof {
  const ts = Date.now();
  const nonce = randomBytes(12).toString('hex');
  return { ts, nonce, signature: sign(message({ xrplAddress: wallet.address, evmAddress, ts, nonce }), wallet.privateKey) };
}

/** Returns null when valid, otherwise the reason. */
export function verifyHelloProof(
  f: { xrplAddress: string; xrplPublicKey: string; evmAddress: string; proof: HelloProof },
  maxSkewMs = 5 * 60_000,
): string | null {
  try {
    if (deriveAddress(f.xrplPublicKey) !== f.xrplAddress) return 'xrplPublicKey does not derive xrplAddress';
  } catch {
    return 'bad xrplPublicKey';
  }
  if (!Number.isFinite(f.proof.ts) || Math.abs(Date.now() - f.proof.ts) > maxSkewMs) return 'proof timestamp out of range';
  try {
    if (!verify(message({ xrplAddress: f.xrplAddress, evmAddress: f.evmAddress, ts: f.proof.ts, nonce: f.proof.nonce }), f.proof.signature, f.xrplPublicKey)) return 'bad proof signature';
  } catch {
    return 'bad proof signature';
  }
  return null;
}
