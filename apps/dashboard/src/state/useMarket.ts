import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { DashboardEvent } from '@shared/protocol';
import { reduce } from './reducer';
import { initialState, type ConnState, type SourceMode } from './types';
import { connectLive, parseJsonl, ReplayPlayer, type ReplayStatus } from './sources';

export type ReplayReason = 'query' | 'default' | 'fallback' | 'file';

export interface MarketControls {
  mode: SourceMode;
  conn: ConnState;
  replay: ReplayStatus | null;
  replayName: string | null;
  replayReason: ReplayReason | null;
  play: () => void;
  pause: () => void;
  setSpeed: (x: number) => void;
  restart: () => void;
  loadReplay: (frames: DashboardEvent[], name: string) => void;
  goLive: () => void;
  recordedCount: number;
  downloadRecording: () => void;
}

const FALLBACK_REPLAY = '/replay/demo.jsonl';
const LIVE_GRACE_MS = 4_000;
const RETRY_LIVE_MS = 20_000;

const params = () => new URLSearchParams(location.search);
const defaultReplay = (): string => (import.meta.env.VITE_DEFAULT_REPLAY as string | undefined)?.trim() ?? '';

async function marketReachable(timeoutMs = 2_500): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch('/v1/market', { signal: ctl.signal, cache: 'no-store' });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export function useMarket() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const forceLive = params().get('live') === '1';
  const queryReplay = params().get('replay');
  const [mode, setMode] = useState<SourceMode>(() => (queryReplay || (!forceLive && defaultReplay()) ? 'replay' : 'live'));
  const [conn, setConn] = useState<ConnState>('connecting');
  const [replay, setReplay] = useState<ReplayStatus | null>(null);
  const [replayName, setReplayName] = useState<string | null>(null);
  const [replayReason, setReplayReason] = useState<ReplayReason | null>(null);
  const [recordedCount, setRecordedCount] = useState(0);
  const player = useRef<ReplayPlayer | null>(null);
  const recorded = useRef<DashboardEvent[]>([]);
  const connRef = useRef<ConnState>('connecting');

  const startReplay = useCallback((frames: DashboardEvent[], name: string, reason: ReplayReason) => {
    player.current?.dispose();
    const p = new ReplayPlayer(frames, (ev) => dispatch(ev), setReplay);
    player.current = p;
    const speed = Number(params().get('speed'));
    if (speed && [1, 4, 16].includes(speed)) p.setSpeed(speed);
    setReplayName(name);
    setReplayReason(reason);
    setMode('replay');
    p.play();
  }, []);

  const loadReplayUrl = useCallback(
    async (url: string, reason: ReplayReason) => {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        const frames = parseJsonl(await r.text());
        if (frames.length) startReplay(frames, url.split('/').pop() ?? 'replay', reason);
        else console.warn('[idle] replay file has no frames:', url);
      } catch (e) {
        console.warn('[idle] replay load failed', url, e);
      }
    },
    [startReplay],
  );

  // initial replay sources: ?replay= wins, then the build-time default (unless ?live=1)
  useEffect(() => {
    if (queryReplay) void loadReplayUrl(queryReplay, 'query');
    else if (!forceLive && defaultReplay()) void loadReplayUrl(defaultReplay(), 'default');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // live source, with a grace period: if the socket never opens and the API is unreachable, replay the recorded run
  useEffect(() => {
    if (mode !== 'live') return;
    recorded.current = [];
    setRecordedCount(0);
    let fellBack = false;
    const dispose = connectLive(
      (ev) => {
        recorded.current.push(ev);
        if (recorded.current.length % 10 === 0) setRecordedCount(recorded.current.length);
        dispatch(ev);
      },
      (s) => {
        connRef.current = s;
        setConn(s);
      },
    );
    const isOpen = () => connRef.current === 'open'; // read through a call so TS does not narrow across the await
    const grace = setTimeout(async () => {
      if (forceLive || isOpen()) return;
      if (await marketReachable()) return; // API is up; the socket will reconnect on its own
      if (isOpen()) return; // may have opened while we probed
      fellBack = true;
      dispose();
      void loadReplayUrl(FALLBACK_REPLAY, 'fallback');
    }, LIVE_GRACE_MS);
    return () => {
      clearTimeout(grace);
      if (!fellBack) dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // while on the automatic fallback, keep checking for the real exchange and switch back when it appears
  useEffect(() => {
    if (mode !== 'replay' || replayReason !== 'fallback') return;
    const id = setInterval(async () => {
      if (await marketReachable(1_500)) {
        player.current?.dispose();
        player.current = null;
        setReplay(null);
        setReplayName(null);
        setReplayReason(null);
        setMode('live');
      }
    }, RETRY_LIVE_MS);
    return () => clearInterval(id);
  }, [mode, replayReason]);

  useEffect(() => () => player.current?.dispose(), []);

  const controls: MarketControls = {
    mode,
    conn,
    replay,
    replayName,
    replayReason,
    play: () => player.current?.play(),
    pause: () => player.current?.pause(),
    setSpeed: (x) => player.current?.setSpeed(x),
    restart: () => player.current?.restart(),
    loadReplay: (frames, name) => startReplay(frames, name, 'file'),
    goLive: () => {
      player.current?.dispose();
      player.current = null;
      setReplay(null);
      setReplayName(null);
      setReplayReason(null);
      setMode('live');
    },
    recordedCount,
    downloadRecording: () => {
      const text = recorded.current.map((f) => JSON.stringify(f)).join('\n') + '\n';
      const blob = new Blob([text], { type: 'application/x-ndjson' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `idle-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },
  };

  return { state, controls };
}
