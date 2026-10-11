import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import type { ProviderView } from '@shared/protocol';
import { ago, ausd, xrp, unitPrice } from '@/lib/format';
import { xrplAccount, xrplTx } from '@/lib/links';
import type { MarketState, StreamState } from '@/state/types';
import { Num } from './Num';

/** A revoked card stays full-size this long after the revocation, then collapses to a row. */
const REVOKED_CARD_MS = 5 * 60_000;
const STREAM_ACTIVE_MS = 30_000;

export const isStreamActive = (s: StreamState, now: number) => !s.settledTx && now - s.lastTs < STREAM_ACTIVE_MS;

function Meter({ busy, slots }: { busy: number; slots: number }) {
  const n = Math.max(1, slots);
  return (
    <div className="flex gap-1" aria-label={`${busy} of ${slots} slots busy`}>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className={clsx('h-2.5 flex-1 rounded-[3px] transition-colors duration-200 ease-out', i < busy ? 'bg-live' : 'bg-rule')} />
      ))}
    </div>
  );
}

export function RackCard({ p, wonAt, stream }: { p: ProviderView; wonAt?: number; stream?: StreamState }) {
  const revoked = p.status === 'suspended';
  const offline = !p.online && !revoked;
  const pending = p.status === 'pending' && !revoked;
  return (
    <motion.article
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: offline ? 0.4 : 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ type: 'spring', duration: 0.45, bounce: 0 }}
      className={clsx(
        'relative rounded-xl border bg-white p-4 flex flex-col gap-3 transition-[filter,border-color] duration-300',
        revoked ? 'border-bad' : 'border-rule',
        offline && 'grayscale',
      )}
    >
      {wonAt ? <div key={wonAt} className="glow-once absolute inset-0 rounded-xl pointer-events-none" aria-hidden /> : null}

      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[18px] font-semibold tracking-tight leading-tight truncate">{p.name}</h3>
          <div className="label mt-0.5 truncate">{p.region}</div>
          <div className="label truncate">{p.hardware.label}</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {revoked ? (
            <span className="text-[12px] px-2 py-0.5 rounded-md border border-bad text-bad">Revoked</span>
          ) : p.tier ? (
            <a
              className="text-[12px] px-2 py-0.5 rounded-md border border-ink text-ink hover:bg-paper-2"
              href={p.credential?.acceptTx ? xrplTx(p.credential.acceptTx) : xrplAccount(p.xrplAddress)}
              target="_blank"
              rel="noreferrer"
              title="XRPL credential"
            >
              Tier {p.tier} · XRPL
            </a>
          ) : (
            <span className="text-[12px] px-2 py-0.5 rounded-md border border-rule-2 text-ink-2">{pending ? 'verifying' : 'offline'}</span>
          )}
          {p.cheat && !revoked && <span className="text-[11px] px-1.5 py-0.5 rounded border border-bad text-bad">cheat mode</span>}
          {p.draining && <span className="text-[11px] px-1.5 py-0.5 rounded border border-rule-2 text-ink-2">draining</span>}
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {p.models.map((m) => (
          <span key={m} className="text-[11px] px-1.5 py-0.5 rounded-[5px] bg-paper-2 text-ink-2 num">
            {m}
          </span>
        ))}
      </div>

      <div>
        <Meter busy={p.busySlots} slots={p.slots} />
        <div className="label mt-1.5">
          {p.busySlots} of {p.slots} slots busy{p.queueDepth > 0 ? `, ${p.queueDepth} queued` : ''}
        </div>
      </div>

      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[30px] leading-none font-medium tracking-tight">
            <Num value={Number(p.asks.embed)} />
            <span className="text-[12px] text-ink-2 ml-1.5 font-normal">µAUSD / text</span>
          </div>
          <div className="label mt-1.5 num">
            surge ×{p.surge.toFixed(2)}&nbsp;&nbsp;shade ×{p.shade.toFixed(2)}
          </div>
        </div>
        <div className="text-right">
          <div className="num text-[15px] leading-tight">
            {unitPrice(p.asks.generate)} <span className="text-ink-3 text-[11px] font-sans">µAUSD/tok</span>
          </div>
          <div className="num text-[15px] leading-tight">
            {unitPrice(p.asks.stream)} <span className="text-ink-3 text-[11px] font-sans">drops/tok</span>
          </div>
        </div>
      </div>

      {stream && (
        <div className="flex items-center gap-2 rounded-lg bg-live-soft px-2.5 py-1.5" aria-live="polite">
          <span className="w-1.5 h-1.5 rounded-full bg-live pulse shrink-0" aria-hidden />
          <span className="text-[12px] text-ink">streaming</span>
          <span className="num text-[13px] ml-auto">
            <Num value={stream.tokens} /> <span className="text-ink-2 text-[11px] font-sans">tokens</span>
          </span>
          <span className="num text-[13px]">
            <Num value={Number(stream.claimedDrops)} /> <span className="text-ink-2 text-[11px] font-sans">drops signed</span>
          </span>
        </div>
      )}

      <footer className="flex items-center justify-between border-t border-rule pt-2.5">
        <div className="num text-[13px]">
          <span>{ausd(p.earnings.ausd)}</span> <span className="text-ink-3 font-sans text-[11px]">AUSD</span>
          <span className="inline-block w-3" />
          <span>{xrp(p.earnings.drops)}</span> <span className="text-ink-3 font-sans text-[11px]">XRP</span>
        </div>
        <div className={clsx('text-[12px]', p.strikes > 0 ? 'text-bad' : 'text-ink-3')}>
          {p.strikes} {p.strikes === 1 ? 'strike' : 'strikes'}
        </div>
      </footer>

      {revoked && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none" aria-live="polite">
          <div className="stamp pointer-events-auto border-[3px] border-bad text-bad px-3 py-1 text-[34px] font-bold tracking-[0.12em] rounded-md bg-white/85">REVOKED</div>
          {p.credential?.deleteTx && (
            <a className="pointer-events-auto mt-2 text-[12px] text-bad underline underline-offset-2 bg-white/85 px-1 rounded" href={xrplTx(p.credential.deleteTx)} target="_blank" rel="noreferrer">
              CredentialDelete on XRPL
            </a>
          )}
        </div>
      )}
    </motion.article>
  );
}

/** One-line row for data centers that are not part of the live market right now. */
function CompactRow({ p, now }: { p: ProviderView; now: number }) {
  const revoked = p.status === 'suspended';
  return (
    <motion.li
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="flex items-center gap-3 py-1.5 text-[13px] border-b border-rule last:border-b-0"
    >
      <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', revoked ? 'bg-bad' : 'bg-rule-2')} aria-hidden />
      <span className={clsx('truncate', revoked ? 'text-ink' : 'text-ink-2')}>{p.name}</span>
      <span className="label truncate">{p.hardware.label}</span>
      <span className={clsx('ml-auto whitespace-nowrap', revoked ? 'text-bad' : 'text-ink-3')}>
        {revoked ? 'revoked' : 'offline'}
        {!revoked && p.lastSeen ? <span className="num"> · seen {ago(p.lastSeen, now)} ago</span> : null}
      </span>
      {revoked && p.credential?.deleteTx && (
        <a className="text-[12px] text-ink-2 underline underline-offset-2 whitespace-nowrap" href={xrplTx(p.credential.deleteTx)} target="_blank" rel="noreferrer">
          XRPL
        </a>
      )}
    </motion.li>
  );
}

export function Racks({ state }: { state: MarketState }) {
  const all = Object.values(state.providers);
  const isFreshRevoked = (p: ProviderView) => p.status === 'suspended' && state.revokedAt[p.id] !== undefined && state.now - state.revokedAt[p.id] < REVOKED_CARD_MS;
  const live = all
    .filter((p) => (p.online && p.status !== 'suspended') || isFreshRevoked(p))
    .sort((a, b) => {
      const rank = (p: ProviderView) => (p.status === 'verified' ? 0 : p.status === 'pending' ? 1 : 2);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });
  const rest = all.filter((p) => !live.includes(p)).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  const activeStreams = Object.values(state.streams).filter((s) => isStreamActive(s, state.now));
  const streamFor = (id: string) => activeStreams.filter((s) => s.providerId === id).sort((a, b) => b.lastTs - a.lastTs)[0];

  return (
    <section className="min-h-0 flex flex-col">
      <h2 className="text-[13px] text-ink-2 mb-2.5">
        Data centers <span className="num text-ink-3">{live.length}</span>
        {rest.length > 0 && <span className="text-ink-3"> · {rest.length} not in market</span>}
      </h2>
      {all.length === 0 ? (
        <div className="pt-4 px-1">
          <div className="text-[14px] text-ink-3">No data centers yet.</div>
          <div className="label mt-1">
            Start one on any laptop with <span className="num">pnpm provider</span>.
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 overflow-hidden fade-bottom content-start min-h-0">
            <AnimatePresence mode="popLayout">
              {live.map((p) => (
                <RackCard key={p.id} p={p} wonAt={state.wins[p.id]} stream={streamFor(p.id)} />
              ))}
            </AnimatePresence>
          </div>
          {rest.length > 0 && (
            <ul className="shrink-0 rounded-xl border border-rule bg-white px-3">
              <AnimatePresence initial={false}>
                {rest.slice(0, 4).map((p) => (
                  <CompactRow key={p.id} p={p} now={state.now} />
                ))}
              </AnimatePresence>
              {rest.length > 4 && <li className="label py-1.5">and {rest.length - 4} more not in the market</li>}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
