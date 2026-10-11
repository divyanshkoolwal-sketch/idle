import clsx from 'clsx';
import { motion } from 'framer-motion';
import { clock } from '@/lib/format';
import type { FeedItem, MarketState } from '@/state/types';

function Row({ f }: { f: FeedItem }) {
  return (
    <motion.li
      initial={{ opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }}
      className="flex gap-3 py-2.5 border-b border-rule last:border-b-0"
    >
      <span className="num text-[11px] text-ink-3 pt-[3px] w-[60px] shrink-0">{clock(f.ts)}</span>
      <span className={clsx('mt-[7px] w-1.5 h-1.5 rounded-full shrink-0', f.tone === 'live' ? 'bg-live' : f.tone === 'bad' ? 'bg-bad' : 'bg-ink-3')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className={clsx('text-[14px] leading-snug', f.tone === 'bad' ? 'text-bad' : 'text-ink')}>{f.title}</div>
        {f.detail && <div className="label mt-0.5">{f.detail}</div>}
      </div>
      {f.href && (
        <a className="text-[12px] text-ink-2 underline underline-offset-2 shrink-0 pt-[2px] hover:text-ink" href={f.href} target="_blank" rel="noreferrer">
          {f.linkLabel ?? 'open'}
        </a>
      )}
    </motion.li>
  );
}

export function Feed({ state }: { state: MarketState }) {
  const items = state.feed.slice(0, 24);
  return (
    <section className="min-h-0 flex flex-col">
      <h2 className="text-[13px] text-ink-2 mb-2.5">Settlements and trust</h2>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-rule-2 p-6 text-ink-2 text-[14px]">Every settlement, channel claim and credential change lands here with its explorer link.</div>
      ) : (
        <ul className="overflow-hidden fade-bottom rounded-xl border border-rule bg-white px-3">
          {items.map((f) => (
            <Row key={f.id} f={f} />
          ))}
        </ul>
      )}
    </section>
  );
}
