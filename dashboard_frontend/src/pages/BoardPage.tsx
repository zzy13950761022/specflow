import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Board } from '../components/Board';
import { NewSpec } from '../components/NewSpec';
import { PromptsPanel } from '../components/PromptsPanel';
import { TabButton } from '../components/TabButton';
import { useAppState } from '../context/AppContext';
import { filterSpecs, readBoardFilters, writeBoardFilters, type BoardFilters } from '../lib/board';
import { STAGE_IDS, STAGE_LABELS } from '../types';

export function BoardPage() {
  const { activeRepo, specs, setError, setActiveRepo, refreshSpecs } = useAppState();
  const [view, setView] = useState<'board' | 'prompts'>('board');
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const filters = readBoardFilters(params);
  const visible = filterSpecs(specs, filters);
  const update = (patch: Partial<BoardFilters>) => setParams(writeBoardFilters({ ...filters, ...patch }), { replace: true });
  if (!activeRepo) return <div className="glass rounded-2xl flex-1 grid place-items-center text-slate-500">Add or select a repository to begin.</div>;
  return <>
    <div className="flex items-center gap-3">
      <h2 className="text-lg font-semibold">Specs</h2>
      <button onClick={() => setCreating(true)} className="joule-gradient rounded-lg px-4 py-2 text-sm font-medium text-white">Create Spec</button>
      <div className="ml-auto flex glass rounded-xl overflow-hidden shrink-0"><TabButton active={view === 'board'} onClick={() => setView('board')}>Board</TabButton><TabButton active={view === 'prompts'} onClick={() => setView('prompts')}>Prompts</TabButton></div>
    </div>
    {view === 'board' && <>
      <div className="glass rounded-2xl p-3 flex flex-wrap items-center gap-2" role="search" aria-label="Filter specs">
        <input aria-label="Search specs" placeholder="Search ticket or title" type="search" value={filters.query} onChange={(e) => update({ query: e.target.value })} className="toolbar-control flex-1 min-w-48" />
        <select className="toolbar-control" aria-label="Filter status" value={filters.status} onChange={(e) => update({ status: e.target.value })}><option value="">All statuses</option>{['ready', 'running', 'waiting_review', 'failed', 'paused', 'completed'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select>
        <select className="toolbar-control" aria-label="Filter stage" value={filters.stage} onChange={(e) => update({ stage: e.target.value })}><option value="">All stages</option>{STAGE_IDS.map((id) => <option key={id} value={id}>{STAGE_LABELS[id]}</option>)}</select>
        <select className="toolbar-control" aria-label="Filter workflow" value={filters.workflow} onChange={(e) => update({ workflow: e.target.value })}><option value="">All workflows</option><option value="standard">Standard feature</option><option value="bugfix">Bug fix</option><option value="documentation">Documentation</option></select>
        <select className="toolbar-control" aria-label="Sort specs" value={filters.sort} onChange={(e) => update({ sort: e.target.value })}><option value="updated">Recently updated</option><option value="created">Recently created</option><option value="ticket">Ticket ID</option></select>
        <button onClick={() => setParams({}, { replace: true })} className="px-2 py-1 text-sm text-blue-700">Clear filters</button>
        <span role="status" className="text-xs text-slate-500">{visible.length} of {specs.length} specs</span>
      </div>
      {specs.length > 0 && visible.length === 0 ? <div className="glass rounded-2xl flex-1 grid place-items-center text-slate-500 text-sm">No specs match your filters.</div> : <Board repoId={activeRepo} specs={visible} />}
    </>}
    {view === 'prompts' && <PromptsPanel repoId={activeRepo} onError={setError} />}
    {creating && <NewSpec activeRepo={activeRepo} onClose={() => setCreating(false)} onCreate={async (repoId, ticketId, title, options) => {
      const created = await api.createSpec(repoId, ticketId, title, options);
      setActiveRepo(repoId);
      await refreshSpecs(repoId);
      setCreating(false);
      const search = params.toString();
      navigate('/repos/' + encodeURIComponent(repoId) + '/specs/' + encodeURIComponent(created.ticketId) + (search ? '?' + search : ''));
    }} />}
  </>;
}
