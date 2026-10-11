import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import type { AgentLog } from '@shared/protocol';
import { clock, ausd, xrp } from '@/lib/format';
import type { MarketState } from '@/state/types';

const PERSONAS: Array<{ id: string; title: string; tagline: string }> = [
  { id: 'analyst', title: 'analyst', tagline: 'urgent — 3 s deadlines, pays up, streams its answer over an XRPL channel' },
  { id: 'indexer', title: 'indexer', tagline: 'patient — 60 s deadlines, backs off when outbid, buys when prices dip' },
];

function spendOf(logs: AgentLog[]) {
  let ausdAtomic = 0n;
  let drops = 0n;
  for (const l of logs) {
    if (l.kind !== 'spend' || !l.meta) continue;
    const amt = l.meta.amount;
    const cur = l.meta.currency;
    try {
      if (cur === 'AUSD' && amt != null) ausdAtomic += BigInt(String(amt));
      if (cur === 'XRP' && amt != null) drops += BigInt(String(amt));
    } catch {
      /* ignore */
    }
  }
  return { ausdAtomic, drops };
}

function Column({ persona, title, tagline, logs }: { persona: string; title: string; tagline: string; logs: AgentLog[] }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);
  const spent = spendOf(logs);
  const last = logs.at(-1);
  return (
    <section className="flex flex-col min-h-0 rounded-xl border border-rule bg-white">
      <header className="px-5 pt-4 pb-3 border-b border-rule flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight">{title}</h2>
          <p className="label mt-1 max-w-[52ch]">{tagline}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="num text-[22px] font-medium leading-none">
            {ausd(spent.ausdAtomic)} <span className="text-[12px] text-ink-2 font-sans">AUSD</span>
            {spent.drops > 0n && (
              <>
                <span className="inline-block w-3" />
                {xrp(spent.drops)} <span className="text-[12px] text-ink-2 font-sans">XRP</span>
              </>
            )}
          </div>
          <div className="label mt-1.5">spent{last ? `, last activity ${clock(last.ts)}` : ''}</div>
        </div>
      </header>
      {logs.length === 0 ? (
        <div className="p-5 text-ink-2 text-[14px]">
          Waiting for {persona}. Start it with <span className="num">pnpm agent --persona {persona} "…"</span>
        </div>
      ) : (
        <ol ref={ref} className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
          {logs.map((l, i) => (
            <li key={`${l.ts}-${i}`} className="flex gap-3 py-2 border-b border-rule/60 last:border-b-0">
              <span className="num text-[11px] text-ink-3 pt-[4px] w-[60px] shrink-0">{clock(l.ts)}</span>
              <span
                className={clsx(
                  'mt-[7px] w-1.5 h-1.5 rounded-full shrink-0',
                  l.kind === 'spend' ? 'bg-live' : l.kind === 'error' ? 'bg-bad' : l.kind === 'result' ? 'bg-ink' : 'bg-rule-2',
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div
                  className={clsx(
                    'text-[14px] leading-snug whitespace-pre-wrap break-words',
                    l.kind === 'thought' && 'text-ink-2',
                    l.kind === 'result' && 'font-medium',
                    l.kind === 'error' && 'text-bad',
                    l.kind === 'spend' && 'num text-[13px]',
                  )}
                >
                  {l.text}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function AgentConsole({ state }: { state: MarketState }) {
  return (
    <main className="flex-1 min-h-0 grid grid-cols-2 gap-4 p-5">
      {PERSONAS.map((p) => (
        <Column key={p.id} persona={p.id} title={p.title} tagline={p.tagline} logs={state.logs.filter((l) => l.persona === p.id)} />
      ))}
    </main>
  );
}
