import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { JobType } from '@shared/protocol';
import { clock } from '@/lib/format';
import type { MarketState } from '@/state/types';
import { Num } from './Num';

const WINDOW = 10 * 60_000;

function Small({ title, unit, jobType, state }: { title: string; unit: string; jobType: JobType; state: MarketState }) {
  const now = state.now || Date.now();
  const ticks = state.prices.filter((p) => p.jobType === jobType).map((p) => ({ ts: p.ts, v: Number(p.unitPrice) }));
  const last = ticks.at(-1);
  const clears = ticks.length;
  const vals = ticks.map((d) => d.v);
  const lo = vals.length ? Math.min(...vals) : 0;
  const hi = vals.length ? Math.max(...vals) : 1;
  const pad = Math.max(1, Math.round((hi - lo) * 0.25));
  // last 10 minutes, but when the session is younger than that, fit the session so the line fills the panel
  const firstAny = state.prices[0]?.ts ?? now;
  const from = Math.max(now - WINDOW, Math.min(firstAny - 5_000, now - 30_000));
  const lead = Math.max(1_500, Math.round((now - from) * 0.05)); // headroom on the right so a fresh step is visible
  const to = now + lead;
  // carry the latest price to the edge: clearing price is a step function
  const data = last ? [...ticks, { ts: to, v: last.v }] : ticks;
  return (
    <div className="flex-1 min-w-0 flex gap-4">
      <div className="w-[120px] shrink-0">
        <div className="text-[13px] text-ink-2">{title}</div>
        <div className="text-[30px] leading-none font-medium tracking-tight mt-1.5">
          {last ? <Num value={last.v} /> : <span className="num text-ink-3">—</span>}
        </div>
        <div className="label mt-1.5">{unit}</div>
        <div className="label mt-0.5">
          {clears ? (
            <>
              <span className="num">{clears}</span> clears, 10 min
            </>
          ) : (
            'no clears yet'
          )}
        </div>
      </div>
      <div className="flex-1 min-w-0 h-[128px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="#e3e1d9" strokeDasharray="0" />
            <XAxis type="number" dataKey="ts" domain={[from, to]} hide />
            <YAxis domain={[Math.max(0, lo - pad), hi + pad]} width={34} tick={{ fontSize: 11, fill: '#9d9b93', fontFamily: 'Geist Mono Variable' }} axisLine={false} tickLine={false} tickCount={3} />
            <Tooltip
              cursor={{ stroke: '#cfcdc3', strokeWidth: 1 }}
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <div className="bg-white border border-rule rounded-md px-2 py-1 text-[12px] shadow-sm">
                    <span className="num font-medium">{payload[0].value as number}</span> <span className="text-ink-2">{unit}</span>
                    <div className="num text-ink-3">{clock(payload[0].payload.ts)}</div>
                  </div>
                ) : null
              }
            />
            <Line type="stepAfter" dataKey="v" stroke="#2140e8" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function PriceStrip({ state }: { state: MarketState }) {
  const providers = Object.values(state.providers).filter((p) => p.online && p.status === 'verified');
  const slots = providers.reduce((n, p) => n + p.slots, 0);
  const busy = providers.reduce((n, p) => n + p.busySlots, 0);
  const pct = slots ? Math.round((busy / slots) * 100) : 0;
  return (
    <section className="h-[200px] shrink-0 border-t border-rule pt-3 flex gap-8">
      <Small title="Embed" unit="µAUSD per text" jobType="embed" state={state} />
      <Small title="Generate" unit="µAUSD per token" jobType="generate" state={state} />
      <Small title="Stream" unit="drops per token" jobType="stream" state={state} />
      <div className="w-[300px] shrink-0 border-l border-rule pl-6">
        <div className="text-[13px] text-ink-2">Supply and demand</div>
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className="text-[30px] leading-none font-medium tracking-tight">
            <Num value={busy} />
            <span className="text-ink-3 font-normal"> / </span>
            <Num value={slots} />
          </span>
          <span className="label">slots busy</span>
        </div>
        <div className="mt-3 h-2.5 rounded-[3px] bg-rule overflow-hidden">
          <div className="h-full bg-live transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-4 flex items-baseline gap-2">
          <span className="text-[30px] leading-none font-medium tracking-tight">
            <Num value={state.openAuctions} />
          </span>
          <span className="label">auctions open now</span>
        </div>
        <div className="label mt-1.5">
          {pct >= 80 ? 'Supply is tight: asks are surging.' : pct >= 40 ? 'Market is busy.' : 'Market is idle: prices sit near floors.'}
        </div>
      </div>
    </section>
  );
}
