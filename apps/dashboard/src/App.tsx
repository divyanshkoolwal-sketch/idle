import { useCallback, useEffect, useState } from 'react';
import { useMarket } from '@/state/useMarket';
import { TopBar } from '@/components/TopBar';
import { Racks } from '@/components/Racks';
import { Auctions } from '@/components/Auctions';
import { Feed } from '@/components/Feed';
import { PriceStrip } from '@/components/PriceStrip';
import { AgentConsole } from '@/components/AgentConsole';
import { AdminDrawer } from '@/components/AdminDrawer';

type Route = 'market' | 'agent';
const readRoute = (): Route => (location.pathname.replace(/\/+$/, '') === '/agent' || location.hash.replace(/^#/, '').replace(/\/+$/, '') === '/agent' ? 'agent' : 'market');

function useRoute(): Route {
  const [r, setR] = useState<Route>(readRoute);
  useEffect(() => {
    const on = () => setR(readRoute());
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('hashchange', on);
    };
  }, []);
  return r;
}

export default function App() {
  const { state, controls } = useMarket();
  const route = useRoute();
  const [admin, setAdmin] = useState(false);
  const close = useCallback(() => setAdmin(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'd' || e.key === 'D') setAdmin((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-paper">
      <TopBar state={state} controls={controls} route={route} />
      {route === 'agent' ? (
        <AgentConsole state={state} />
      ) : (
        <>
          <main className="flex-1 min-h-0 grid grid-cols-[40fr_35fr_25fr] gap-6 px-7 pt-4 pb-2">
            <Racks state={state} />
            <Auctions state={state} />
            <Feed state={state} />
          </main>
          <div className="px-7 pb-4">
            <PriceStrip state={state} />
          </div>
        </>
      )}
      <AdminDrawer open={admin} onClose={close} state={state} controls={controls} />
    </div>
  );
}
