import { Wallet } from 'xrpl';
import { CREDENTIAL_TYPES } from '@idle/shared';
import { createCredential, deleteCredential, lookupCredential, invalidateCredentialCache } from '@idle/pay-xrpl';
import type { Ctx } from './context';
import type { LiveProvider } from './providers';
import { newId, now } from './ids';

const CRED_TTL_MS = 24 * 3600_000;

/** XRPL Credentials as the data-center trust layer: issue after the challenge, accept by the provider, delete on strikes. */
export class CredentialService {
  readonly issuer: Wallet;
  private retries = new Map<string, NodeJS.Timeout>();

  constructor(private ctx: Ctx) {
    const seed = process.env.EXCHANGE_XRPL_SEED;
    if (!seed && ctx.config.credentials === 'on') throw new Error('EXCHANGE_XRPL_SEED missing — run pnpm setup:wallets (or set CREDENTIALS=off)');
    this.issuer = seed ? Wallet.fromSeed(seed) : Wallet.generate();
  }

  get issuerAddress(): string {
    return this.issuer.address;
  }

  private typeFor(p: LiveProvider): string {
    return CREDENTIAL_TYPES[p.tier ?? 'B'];
  }

  async onboard(p: LiveProvider): Promise<void> {
    const type = this.typeFor(p);
    const t = this.retries.get(p.id);
    if (t) clearTimeout(t);
    try {
      const existing = await lookupCredential(p.xrplAddress, this.issuer.address, type);
      let row = this.ctx.repo.latestCredential(p.id);
      if (row && row.credential_type !== type) row = undefined;
      if (existing.exists && !existing.expired && existing.accepted) {
        if (!row || row.status === 'revoked') {
          row = { id: newId('c'), provider_id: p.id, credential_type: type, issue_tx: null, accept_tx: null, delete_tx: null, status: 'accepted', updated_at: now() };
          this.ctx.repo.upsertCredential(row);
        } else if (row.status !== 'accepted') {
          this.ctx.repo.updateCredential(row.id, { status: 'accepted', updated_at: now() });
        }
        p.credential = { type, issueTx: row.issue_tx ?? undefined, acceptTx: row.accept_tx ?? undefined, status: 'accepted' };
        console.log(`[credentials] ${p.name} already holds ${type} (accepted) — reusing`);
        this.markVerified(p);
        return;
      }
      if (existing.exists && !existing.expired && !existing.accepted) {
        const txHash = row?.issue_tx ?? '';
        p.credential = { type, issueTx: txHash || undefined, status: 'offered' };
        console.log(`[credentials] ${p.name} has an unaccepted ${type} on-ledger — re-offering`);
        this.ctx.registry.send(p.id, { type: 'credential.offered', credentialType: type, issuer: this.issuer.address, txHash, tier: p.tier ?? 'B' });
        return;
      }
      if (existing.exists && existing.expired) {
        console.log(`[credentials] ${p.name} has an expired ${type}; deleting before re-issue`);
        await deleteCredential(this.issuer, p.xrplAddress, type);
      }
      const { txHash } = await createCredential(this.issuer, p.xrplAddress, type, {
        uri: `${this.ctx.config.exchangeUrl}/v1/providers/${p.id}`,
        expiresInMs: CRED_TTL_MS,
      });
      row = { id: newId('c'), provider_id: p.id, credential_type: type, issue_tx: txHash, accept_tx: null, delete_tx: null, status: 'offered', updated_at: now() };
      this.ctx.repo.upsertCredential(row);
      p.credential = { type, issueTx: txHash, status: 'offered' };
      console.log(`[credentials] issued ${type} to ${p.name}: ${txHash}`);
      this.ctx.events.emit({ type: 'credential.issued', providerId: p.id, providerName: p.name, txHash, credentialType: type, tier: p.tier ?? 'B' });
      this.ctx.registry.send(p.id, { type: 'credential.offered', credentialType: type, issuer: this.issuer.address, txHash, tier: p.tier ?? 'B' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[credentials] issue failed for ${p.name}: ${msg}`);
      this.ctx.registry.send(p.id, { type: 'error', code: 'CREDENTIAL_ISSUE_FAILED', message: msg });
      this.retries.set(
        p.id,
        setTimeout(() => {
          if (p.online && p.status !== 'verified' && p.status !== 'suspended') void this.onboard(p);
        }, 15_000),
      );
    }
  }

  async onAccepted(p: LiveProvider, txHash: string): Promise<void> {
    const type = p.credential?.type ?? this.typeFor(p);
    for (let i = 0; i < 30; i++) {
      invalidateCredentialCache(p.xrplAddress);
      const l = await lookupCredential(p.xrplAddress, this.issuer.address, type).catch(() => undefined);
      if (l?.exists && l.accepted && !l.expired) {
        const row = this.ctx.repo.latestCredential(p.id);
        if (row && row.credential_type === type) this.ctx.repo.updateCredential(row.id, { accept_tx: txHash, status: 'accepted', updated_at: now() });
        p.credential = { ...(p.credential ?? { type }), type, acceptTx: txHash, status: 'accepted' };
        console.log(`[credentials] ${p.name} accepted ${type}: ${txHash}`);
        this.ctx.events.emit({ type: 'credential.accepted', providerId: p.id, providerName: p.name, txHash });
        this.markVerified(p);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.ctx.registry.send(p.id, { type: 'error', code: 'CREDENTIAL_NOT_ACCEPTED', message: 'ledger_entry does not show lsfAccepted after 30 s' });
  }

  private markVerified(p: LiveProvider): void {
    this.ctx.registry.setStatus(p, 'verified');
    this.ctx.registry.send(p.id, { type: 'verified', tier: p.tier ?? 'B' });
    this.ctx.events.emit({
      type: 'provider.verified',
      providerId: p.id,
      tier: p.tier ?? 'B',
      credential: { type: p.credential?.type ?? '', issueTx: p.credential?.issueTx ?? '', acceptTx: p.credential?.acceptTx ?? '' },
    });
    this.ctx.registry.emitUtil(p);
  }

  /** Issuer deletes the credential on-ledger. Returns the tx hash (undefined if the ledger call failed). */
  async revoke(p: LiveProvider): Promise<string | undefined> {
    const type = p.credential?.type && p.credential.type !== 'dev' ? p.credential.type : this.typeFor(p);
    try {
      const { txHash } = await deleteCredential(this.issuer, p.xrplAddress, type);
      const row = this.ctx.repo.latestCredential(p.id);
      if (row) this.ctx.repo.updateCredential(row.id, { delete_tx: txHash, status: 'revoked', updated_at: now() });
      p.credential = { ...(p.credential ?? { type }), type, deleteTx: txHash, status: 'revoked' };
      invalidateCredentialCache(p.xrplAddress);
      console.log(`[credentials] REVOKED ${type} for ${p.name}: ${txHash}`);
      return txHash;
    } catch (err) {
      console.error(`[credentials] revoke failed for ${p.name}:`, err instanceof Error ? err.message : err);
      return undefined;
    }
  }
}
