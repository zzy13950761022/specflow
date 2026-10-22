import { useState } from 'react';
import { api } from '../api';
import { Board } from '../components/Board';
import { NewSpec } from '../components/NewSpec';
import { PromptsPanel } from '../components/PromptsPanel';
import { TabButton } from '../components/TabButton';
import { useAppState } from '../context/AppContext';

export function BoardPage() {
  const { activeRepo, specs, setError } = useAppState();
  const [view, setView] = useState<'board' | 'prompts'>('board');

  if (!activeRepo) {
    return (
      <div className="glass rounded-2xl flex-1 grid place-items-center text-joule-muted">
        Add or select a repository to begin.
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-3">
        {view === 'board' && (
          <NewSpec
            onCreate={async (ticketId, title) => {
              try {
                await api.createSpec(activeRepo, ticketId, title);
              } catch (e) {
                setError(String((e as Error).message));
              }
            }}
          />
        )}
        <div className="ml-auto flex glass rounded-xl overflow-hidden shrink-0">
          <TabButton active={view === 'board'} onClick={() => setView('board')}>
            Board
          </TabButton>
          <TabButton active={view === 'prompts'} onClick={() => setView('prompts')}>
            Prompts
          </TabButton>
        </div>
      </div>
      {view === 'board' && <Board repoId={activeRepo} specs={specs} />}
      {view === 'prompts' && <PromptsPanel repoId={activeRepo} onError={setError} />}
    </>
  );
}
