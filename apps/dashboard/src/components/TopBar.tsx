import clsx from 'clsx';
import type { MarketState } from '@/state/types';
import type { MarketControls } from '@/state/useMarket';
import { Num } from './Num';

function Stat({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-col justify-center min-w-0', className)}>
      <div className="text-[26px] leading-none font-medium tracking-tight whitespace-nowrap">{children}</div>
      <div className="label mt-1.5 whitespace-nowrap">{label}</div>
    </div>
  );
}

function Price({ label, value, unit }: { label: string; value?: string; unit: string }) {
  return (
    <div className="flex flex-col justify-center min-w-0">
      <div className="text-[26px] leading-none font-medium tracking-tight whitespace-nowrap">
        {value ? <Num value={Number(value)} /> : <span className="num text-ink-3">—</span>}
        <span className="text-[12px] text-ink-2 ml-1.5 font-normal font-sans">{unit}</span>
      </div>
      <div className="label mt-1.5 whitespace-nowrap">{label}</div>
    </div>
  );
}

export function TopBar({ state, controls, route }: { state: MarketState; controls: MarketControls; route: 'market' | 'agent' }) {
  const providers = Object.values(state.providers);
  const online = providers.filter((p) => p.online && p.status !== 'suspended').length;
  const verified = providers.filter((p) => p.online && p.status === 'verified').length;
  const live = controls.mode === 'live';
  const dotClass = live ? (controls.conn === 'open' ? 'bg-live pulse' : 'bg-ink-3') : 'bg-ink';
  const statusText = live ? (controls.conn === 'open' ? 'live' : controls.conn === 'connecting' ? 'connecting' : 'reconnecting') : `replay ×${controls.replay?.speed ?? 1}`;

  return (
    <header className="h-[76px] shrink-0 border-b border-rule flex items-center gap-10 px-7">
      <div className="flex items-center gap-3 w-[170px] shrink-0">
        <a href="/" className="text-[28px] font-semibold tracking-[-0.03em] leading-none">
          Idle
        </a>
        <span className={clsx('inline-block w-2.5 h-2.5 rounded-full', dotClass)} aria-hidden />
        <span className="text-[13px] text-ink-2 whitespace-nowrap">{statusText}</span>
      </div>

      <Stat label="Jobs cleared">
        <Num value={state.stats.jobsCleared} />
      </Stat>
      <Stat label="AUSD settled">
        <Num value={Number(state.stats.ausdSettled) / 1e6} decimals={4} />
      </Stat>
      <Stat label="XRP streamed">
        <Num value={Number(state.stats.dropsStreamed) / 1e6} decimals={3} />
      </Stat>
      <Stat label="Data centers online / verified">
        <Num value={online} />
        <span className="text-ink-3 font-normal"> / </span>
        <Num value={verified} />
      </Stat>

      <div className="h-9 w-px bg-rule" aria-hidden />

      <Price label="Embed, clearing" value={state.stats.clearing.embed} unit="µAUSD / text" />
      <Price label="Generate, clearing" value={state.stats.clearing.generate} unit="µAUSD / token" />
      <Price label="Stream, clearing" value={state.stats.clearing.stream} unit="drops / token" />

      <nav className="ml-auto flex items-center gap-2 text-[13px]">
        {!live && controls.replay && (
          <div className="flex items-center gap-1 mr-3">
            <button className="btn !min-h-8 !py-1 !px-2.5" onClick={controls.replay.playing ? controls.pause : controls.play}>
              {controls.replay.playing ? 'Pause' : 'Play'}
            </button>
            {[1, 4, 16].map((s) => (
              <button
                key={s}
                className={clsx('btn !min-h-8 !py-1 !px-2.5 num', controls.replay?.speed === s && 'btn-primary')}
                onClick={() => controls.setSpeed(s)}
                aria-pressed={controls.replay?.speed === s}
              >
                ×{s}
              </button>
            ))}
            <span className="num text-ink-3 ml-2 w-[72px] text-right">
              {controls.replay.index}/{controls.replay.total}
            </span>
          </div>
        )}
        <a href="/" className={clsx('px-3 py-2 rounded-md', route === 'market' ? 'bg-paper-2 text-ink' : 'text-ink-2')}>
          Market
        </a>
        <a href="/agent" className={clsx('px-3 py-2 rounded-md', route === 'agent' ? 'bg-paper-2 text-ink' : 'text-ink-2')}>
          Agents
        </a>
      </nav>
    </header>
  );
}
