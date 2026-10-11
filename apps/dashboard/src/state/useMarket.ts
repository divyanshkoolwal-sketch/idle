import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { DashboardEvent } from '@shared/protocol';
import { reduce } from './reducer';
import { initialState, type ConnState, type SourceMode } from './types';
import { connectLive, parseJsonl, ReplayPlayer, type ReplayStatus } from './sources';

export interface MarketControls {
  mode: SourceMode;
  conn: ConnState;
  replay: ReplayStatus | null;
  replayName: string | null;
  play: () => void;
  pause: () => void;
  setSpeed: (x: number) => void;
  restart: () => void;
  loadReplay: (frames: DashboardEvent[], name: string) => void;
  goLive: () => void;
  recordedCount: number;
  downloadRecording: () => void;
}

export function useMarket() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [mode, setMode] = useState<SourceMode>(() => (new URLSearchParams(location.search).get('replay') ? 'replay' : 'live'));
  const [conn, setConn] = useState<ConnState>('connecting');
  const [replay, setReplay] = useState<ReplayStatus | null>(null);
  const [replayName, setReplayName] = useState<string | null>(null);
  const [recordedCount, setRecordedCount] = useState(0);
  const player = useRef<ReplayPlayer | null>(null);
  const recorded = useRef<DashboardEvent[]>([]);
  const framesRef = useRef<DashboardEvent[]>([]);

  const startReplay = useCallback((frames: DashboardEvent[], name: string) => {
    player.current?.dispose();
    framesRef.current = frames;
    const p = new ReplayPlayer(frames, (ev) => dispatch(ev), setReplay);
    player.current = p;
    const speed = Number(new URLSearchParams(location.search).get('speed'));
    if (speed && [1, 4, 16].includes(speed)) p.setSpeed(speed);
    setReplayName(name);
    setMode('replay');
    p.play();
  }, []);

  // live source
  useEffect(() => {
    if (mode !== 'live') return;
    recorded.current = [];
    setRecordedCount(0);
    const dispose = connectLive(
      (ev) => {
        recorded.current.push(ev);
        if (recorded.current.length % 10 === 0) setRecordedCount(recorded.current.length);
        dispatch(ev);
      },
      setConn,
    );
    return dispose;
  }, [mode]);

  // replay from ?replay=
  useEffect(() => {
    const url = new URLSearchParams(location.search).get('replay');
    if (!url) return;
    let cancelled = false;
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (cancelled) return;
        const frames = parseJsonl(t);
        if (frames.length) startReplay(frames, url.split('/').pop() ?? 'replay');
        else console.warn('[idle] replay file has no frames');
      })
      .catch((e) => console.warn('[idle] replay load failed', e));
    return () => {
      cancelled = true;
    };
  }, [startReplay]);

  useEffect(() => () => player.current?.dispose(), []);

  const controls: MarketControls = {
    mode,
    conn,
    replay,
    replayName,
    play: () => player.current?.play(),
    pause: () => player.current?.pause(),
    setSpeed: (x) => player.current?.setSpeed(x),
    restart: () => player.current?.restart(),
    loadReplay: startReplay,
    goLive: () => {
      player.current?.dispose();
      player.current = null;
      setReplay(null);
      setReplayName(null);
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
