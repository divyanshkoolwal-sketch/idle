import { cosine } from '@idle/shared';
import type { JobResult } from '@idle/shared';
import type { Ctx } from './context';
import type { LiveProvider } from './providers';

type Verification = JobResult['verification'];

/** Runtime spot checks: re-embed a sample on another verified provider or the exchange's reference model. */
export class Verifier {
  constructor(private ctx: Ctx) {}

  async spotCheck(p: LiveProvider, jobId: string, texts: string[], embeddings: number[][], force = false): Promise<Verification> {
    const { config, registry, reference, market, events } = this.ctx;
    if (!force && Math.random() >= config.spotcheckRate) return { sampled: false };
    if (!texts.length) return { sampled: false };
    const idx = new Set<number>();
    while (idx.size < Math.min(2, texts.length)) idx.add(Math.floor(Math.random() * texts.length));
    const sampleIdx = [...idx];
    const sample = sampleIdx.map((i) => texts[i]);
    const claimed = sampleIdx.map((i) => embeddings[i]);

    let ref: number[][] | undefined;
    let via: 'provider' | 'reference' = 'reference';
    const others = registry.eligible({ model: config.embedModel, jobType: 'embed' }).filter((x) => x.id !== p.id);
    // random verifier so a colluding partner cannot be chosen deterministically; reference-only once suspected
    const other = p.strikes > 0 || others.length === 0 ? undefined : others[Math.floor(Math.random() * others.length)];
    if (other) {
      ref = await market.dispatchInternal(other, 'embed', { texts: sample }, config.embedModel, 8000).then((o) => o?.embeddings).catch(() => undefined);
      if (ref && ref.length === sample.length) via = 'provider';
      else ref = undefined;
    }
    if (!ref) ref = await reference.embed(sample);
    const minCos = (vs: number[][]) => Math.min(...claimed.map((c, i) => cosine(c ?? [], vs[i] ?? [])));
    let min = minCos(ref);
    let passed = min >= config.verifyCosine;
    if (!passed && via === 'provider') {
      // never strike on another provider's word alone: confirm with our own model
      const ref2 = await reference.embed(sample);
      min = minCos(ref2);
      passed = min >= config.verifyCosine;
      via = 'reference';
    }
    if (passed) {
      events.emit({ type: 'verify.passed', jobId, providerId: p.id, cosine: min });
      console.log(`[verify] ${p.name} job ${jobId} passed spot check via ${via} (cosine ${min.toFixed(4)})`);
    } else {
      console.log(`[verify] ${p.name} job ${jobId} FAILED spot check via ${via} (cosine ${min.toFixed(4)})`);
      await this.strike(p, jobId, min);
    }
    return { sampled: true, passed, cosine: Number(min.toFixed(6)) };
  }

  async strike(p: LiveProvider, jobId: string, cos: number): Promise<void> {
    const { config, registry, repo, events, credentials } = this.ctx;
    p.strikes++;
    repo.updateProvider(p.id, { strikes: p.strikes });
    events.emit({ type: 'verify.failed', jobId, providerId: p.id, cosine: cos, strikes: p.strikes });
    events.emit({ type: 'provider.strike', providerId: p.id, strikes: p.strikes, jobId });
    if (p.strikes < config.strikesToRevoke || p.status === 'suspended') return;

    registry.setStatus(p, 'suspended');
    for (const key of [...p.reservations.keys()]) registry.release(key);
    let deleteTx: string | undefined;
    if (config.credentials === 'on' && p.credential && p.credential.type !== 'dev' && p.credential.status !== 'revoked') {
      deleteTx = await credentials.revoke(p);
    }
    events.emit({ type: 'provider.suspended', providerId: p.id, strikes: p.strikes, deleteTx });
    if (deleteTx) events.emit({ type: 'credential.revoked', providerId: p.id, providerName: p.name, txHash: deleteTx, strikes: p.strikes });
    registry.send(p.id, { type: 'error', code: 'SUSPENDED', message: `credential revoked after ${p.strikes} failed verifications` });
    registry.emitUtil(p);
    console.log(`[verify] SUSPENDED ${p.name} after ${p.strikes} strikes${deleteTx ? ` (CredentialDelete ${deleteTx})` : ''}`);
  }
}
