import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import type { MarketState } from '@/state/types';
import type { MarketControls } from '@/state/useMarket';
import { parseJsonl } from '@/state/sources';

const TOKEN_KEY = 'idle.adminToken';

async function admin(path: string, token: string, body: unknown): Promise<string> {
  try {
    const r = await fetch(`/v1/admin/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return `${r.status} ${text.slice(0, 160)}`;
  } catch (e) {
    return `request failed: ${(e as Error).message}`;
  }
}

export function AdminDrawer({ open, onClose, state, controls }: { open: boolean; onClose: () => void; state: MarketState; controls: MarketControls }) {
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [burstJobs, setBurstJobs] = useState(20);
  const [burstType, setBurstType] = useState<'embed' | 'generate'>('embed');
  const [result, setResult] = useState('');
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const saveToken = (t: string) => {
    setToken(t);
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* ignore */
    }
  };

  const providers = Object.values(state.providers).filter((p) => p.online);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="overlay" className="fixed inset-0 bg-ink/20 z-40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} onClick={onClose} />
          <motion.aside
            key="drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Admin"
            className="fixed top-0 right-0 h-full w-[420px] bg-white border-l border-rule z-50 flex flex-col overflow-y-auto"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          >
            <div className="p-5 border-b border-rule flex items-center justify-between">
              <h2 className="text-[18px] font-semibold tracking-tight">Admin</h2>
              <button className="btn" onClick={onClose} aria-label="Close admin drawer">
                Close
              </button>
            </div>

            <div className="p-5 flex flex-col gap-6">
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] text-ink-2">Admin token</span>
                <input ref={first} className="input num" type="password" value={token} onChange={(e) => saveToken(e.target.value)} placeholder="ADMIN_TOKEN from .env" autoComplete="off" />
              </label>

              <section className="flex flex-col gap-2">
                <h3 className="text-[13px] text-ink-2">Burst load</h3>
                <div className="flex gap-2">
                  <input className="input num !w-24" type="number" min={1} max={500} value={burstJobs} onChange={(e) => setBurstJobs(Number(e.target.value))} aria-label="Number of jobs" />
                  <select className="input !w-32" value={burstType} onChange={(e) => setBurstType(e.target.value as 'embed' | 'generate')} aria-label="Job type">
                    <option value="embed">embed</option>
                    <option value="generate">generate</option>
                  </select>
                  <button className="btn btn-primary" onClick={async () => setResult(await admin('burst', token, { jobs: burstJobs, jobType: burstType }))}>
                    Send jobs
                  </button>
                </div>
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-[13px] text-ink-2">Data centers</h3>
                {providers.length === 0 && <div className="text-[13px] text-ink-3">none online</div>}
                {providers.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 border border-rule rounded-lg px-3 py-2">
                    <span className="text-[14px] truncate">{p.name}</span>
                    <div className="flex gap-1.5 shrink-0">
                      <button className={clsx('btn !min-h-8 !py-1 !px-2.5 text-[13px]', p.cheat && '!border-bad !text-bad')} onClick={async () => setResult(await admin('cheat', token, { providerId: p.id, on: !p.cheat }))}>
                        {p.cheat ? 'Stop cheating' : 'Cheat'}
                      </button>
                      <button className="btn !min-h-8 !py-1 !px-2.5 text-[13px]" onClick={async () => setResult(await admin('drain', token, { providerId: p.id, on: !p.draining }))}>
                        {p.draining ? 'Undrain' : 'Drain'}
                      </button>
                    </div>
                  </div>
                ))}
              </section>

              {result && <div className="num text-[12px] text-ink-2 border border-rule rounded-lg p-2 break-all">{result}</div>}

              <section className="flex flex-col gap-2 border-t border-rule pt-5">
                <h3 className="text-[13px] text-ink-2">Replay</h3>
                <p className="label">Play a recorded session instead of the live feed. Loops when it ends.</p>
                <div className="flex gap-2 flex-wrap">
                  <button className="btn" onClick={() => (location.href = '/?replay=/replay/demo.jsonl')}>
                    Demo replay
                  </button>
                  <label className="btn cursor-pointer">
                    Open JSONL…
                    <input
                      type="file"
                      accept=".jsonl,.ndjson,.txt"
                      className="sr-only"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        const frames = parseJsonl(await f.text());
                        if (frames.length) controls.loadReplay(frames, f.name);
                        else setResult('no frames in that file');
                      }}
                    />
                  </label>
                  {controls.mode === 'replay' && (
                    <button className="btn" onClick={controls.goLive}>
                      Back to live
                    </button>
                  )}
                </div>
                {controls.mode === 'replay' && controls.replay && (
                  <div className="flex items-center gap-2">
                    <button className="btn" onClick={controls.replay.playing ? controls.pause : controls.play}>
                      {controls.replay.playing ? 'Pause' : 'Play'}
                    </button>
                    <button className="btn" onClick={controls.restart}>
                      Restart
                    </button>
                    {[1, 4, 16].map((s) => (
                      <button key={s} className={clsx('btn num', controls.replay?.speed === s && 'btn-primary')} onClick={() => controls.setSpeed(s)}>
                        ×{s}
                      </button>
                    ))}
                  </div>
                )}
                {controls.mode === 'live' && (
                  <button className="btn" onClick={controls.downloadRecording} disabled={controls.recordedCount === 0}>
                    Download recording ({controls.recordedCount} frames)
                  </button>
                )}
              </section>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
