import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { api, connectWs } from './api';
import { Header } from './components/Header';
import { AppContext } from './context/AppContext';
import type { RepoEntry, SpecFile } from './types';

export function App() {
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [specs, setSpecs] = useState<SpecFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshRepos = useCallback(async () => {
    const list = await api.listRepos();
    setRepos(list);
    setActiveRepo((cur) => cur ?? list[0]?.id ?? null);
  }, []);

  const refreshSpecs = useCallback(async (repoId: string) => {
    try {
      setSpecs(await api.listSpecs(repoId));
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);

  useEffect(() => {
    refreshRepos();
  }, [refreshRepos]);

  useEffect(() => {
    if (activeRepo) refreshSpecs(activeRepo);
  }, [activeRepo, refreshSpecs]);

  // Live updates: any spec.* / repo.* event refreshes the relevant view.
  useEffect(() => {
    return connectWs((event) => {
      if (event.type?.startsWith('repo.')) refreshRepos();
      if (event.type?.startsWith('spec.') && activeRepo) refreshSpecs(activeRepo);
    });
  }, [activeRepo, refreshRepos, refreshSpecs]);

  // Fallback polling: re-fetch every 5s to catch any missed WS events.
  useEffect(() => {
    if (!activeRepo) return;
    const id = setInterval(() => refreshSpecs(activeRepo), 5000);
    return () => clearInterval(id);
  }, [activeRepo, refreshSpecs]);

  return (
    <AppContext.Provider
      value={{ repos, activeRepo, specs, error, setActiveRepo, refreshSpecs, setError }}
    >
      <div className="h-screen w-screen flex flex-col overflow-hidden">
        <Header
          repos={repos}
          activeRepo={activeRepo}
          onSelect={setActiveRepo}
          onAdd={async (path) => {
            try {
              const r = await api.addRepo(path);
              setActiveRepo(r.id);
            } catch (e) {
              setError(String((e as Error).message));
            }
          }}
          onBrowse={async () => {
            try {
              const r = await api.pickRepo();
              if (r) setActiveRepo(r.id);
            } catch (e) {
              setError(String((e as Error).message));
            }
          }}
        />
        <main className="flex-1 flex flex-col gap-4 p-4 overflow-auto">
          {error && (
            <div className="glass rounded-xl px-4 py-2 text-sm text-red-600 border-red-400/40">
              {error}
              <button
                className="ml-3 opacity-70 hover:opacity-100"
                onClick={() => setError(null)}
              >
                dismiss
              </button>
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </AppContext.Provider>
  );
}
