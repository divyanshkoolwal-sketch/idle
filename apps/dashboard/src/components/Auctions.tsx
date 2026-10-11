import clsx from 'clsx';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import type { AuctionView, BidView } from '@shared/protocol';
import { ago, jobLabel, ms, unitPrice, unitSymbol, perUnit } from '@/lib/format';
import type { MarketState } from '@/state/types';

function Bar({ bid, pct, winner, isWinnerKey, currency }: { bid: BidView; pct: number; winner: boolean; isWinnerKey?: number; currency: 'AUSD' | 'XRP' }) {
  const reduce = useReducedMotion();
  return (
    <div className={clsx('py-1', !bid.valid && 'opacity-60')}>
      <div className="flex items-baseline justify-between gap-3 text-[13px] leading-tight">
        <span className={clsx('truncate', winner ? 'font-semibold' : 'text-ink-2')}>{bid.providerName}</span>
        <span className="num whitespace-nowrap">
          <span className={clsx(winner && 'text-live font-semibold')}>{unitPrice(bid.unitPrice)}</span>
          <span className="text-ink-3 text-[11px] font-sans"> {unitSymbol(currency)}</span>
          <span className="text-ink-3 text-[11px] ml-2">{ms(bid.etaMs)}</span>
        </span>
      </div>
      <div className="relative h-2 mt-1 rounded-[3px] bg-paper-2 overflow-visible">
        <motion.div
          key={bid.providerId + ':' + bid.unitPrice}
          className={clsx('bar-fill absolute inset-y-0 left-0 rounded-[3px]', winner ? 'bg-live' : bid.valid ? 'bg-ink/20' : 'bg-transparent border border-dashed border-ink-3')}
          style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
          initial={reduce ? false : { scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ type: 'spring', duration: 0.55, bounce: 0.12 }}
        >
          {winner && isWinnerKey ? <div key={isWinnerKey} className="glow-once absolute inset-0 rounded-[3px]" aria-hidden /> : null}
        </motion.div>
      </div>
      {!bid.valid && bid.reason && <div className="label mt-1">{bid.reason}</div>}
    </div>
  );
}

export function AuctionCard({ a, now }: { a: AuctionView; now: number }) {
  const bids = [...a.bids].sort((x, y) => Number(x.valid) - Number(y.valid) || Number(BigInt(x.unitPrice) - BigInt(y.unitPrice)) || x.etaMs - y.etaMs);
  const scale = Math.max(Number(a.maxUnitPrice), ...bids.map((b) => Number(b.unitPrice)), 1);
  const cleared = a.status === 'cleared';
  const failed = a.status === 'no_bids' || a.status === 'no_acceptable_bid' || a.status === 'expired';
  const best = bids.find((b) => b.valid) ?? bids[0];
  return (
    <motion.article
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ type: 'spring', duration: 0.4, bounce: 0 }}
      className={clsx('rounded-xl border bg-white p-4', cleared ? 'border-rule' : failed ? 'border-bad/50' : 'border-live/40')}
    >
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-[16px] font-semibold tracking-tight">{jobLabel(a.jobType, a.units)}</h3>
        <div className="flex items-center gap-2 text-[12px] text-ink-2 whitespace-nowrap">
          {a.persona && <span className="px-1.5 py-0.5 rounded-[5px] bg-paper-2">{a.persona}</span>}
          <span className="num">
            max {unitPrice(a.maxUnitPrice)} {unitSymbol(a.currency)}
          </span>
          <span className="num text-ink-3">{ago(a.openedAt, now)} ago</span>
        </div>
      </header>

      <div className="mt-2">
        {bids.length === 0 ? (
          <div className="label py-2">{a.status === 'open' ? 'collecting bids…' : 'no bids'}</div>
        ) : (
          bids.map((b) => (
            <Bar
              key={b.providerId}
              bid={b}
              pct={(Number(b.unitPrice) / scale) * 100}
              winner={cleared && b.providerId === a.winnerProviderId}
              isWinnerKey={cleared && b.providerId === a.winnerProviderId ? a.closedAt : undefined}
              currency={a.currency}
            />
          ))
        )}
      </div>

      <footer className="mt-2 pt-2 border-t border-rule flex items-baseline justify-between gap-3">
        <span className={clsx('text-[12px]', failed ? 'text-bad' : 'text-ink-2')}>
          {a.status === 'open' && 'open · sealed bids, 250 ms window'}
          {cleared && `won by ${a.winnerName ?? a.winnerProviderId}`}
          {a.status === 'no_acceptable_bid' && `no acceptable bid${best ? ` · best ${unitPrice(best.unitPrice)} > max ${unitPrice(a.maxUnitPrice)}` : ''}`}
          {a.status === 'no_bids' && 'no capacity'}
          {a.status === 'expired' && 'expired'}
        </span>
        {cleared && a.clearingUnitPrice && (
          <span className="text-[13px] whitespace-nowrap">
            pays 2nd price <span className="num text-[20px] font-semibold text-live align-baseline">{unitPrice(a.clearingUnitPrice)}</span>
            <span className="text-ink-3 text-[11px]"> {unitSymbol(a.currency)} / {perUnit(a.jobType)}</span>
          </span>
        )}
      </footer>
    </motion.article>
  );
}

export function Auctions({ state }: { state: MarketState }) {
  const list = state.auctions.slice(0, 8);
  return (
    <section className="min-h-0 flex flex-col">
      <h2 className="text-[13px] text-ink-2 mb-2.5">
        Live auctions <span className="num text-ink-3">{state.openAuctions} open</span>
      </h2>
      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-rule-2 p-6 text-ink-2 text-[14px]">No auctions yet. Post a job and bids appear here within 250 ms.</div>
      ) : (
        <div className="flex flex-col gap-3 overflow-hidden fade-bottom">
          <AnimatePresence initial={false}>
            {list.map((a) => (
              <AuctionCard key={a.id} a={a} now={state.now} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}
