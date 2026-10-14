import { useEffect, useMemo, useState, useCallback } from 'react';
import { api, connectWs } from './api';
import {
  STAGE_IDS,
  STAGE_LABELS,
  type RepoEntry,
  type SpecFile,
  type Stage,
  type StageId,
  type TemplateSummary,
  type TemplateSource,
} from './types';

export function App() {
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [specs, setSpecs] = useState<SpecFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'board' | 'prompts'>('board');

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

  return (
    <div className="min-h-full flex flex-col">
      <Header />
      <div className="flex-1 flex gap-4 p-4 overflow-hidden">
        <Sidebar
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
        <main className="flex-1 flex flex-col gap-4 overflow-hidden">
          {activeRepo && (
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
          )}
          {error && (
            <div className="glass rounded-xl px-4 py-2 text-sm text-red-300 border-red-400/40">
              {error}
              <button className="ml-3 opacity-70 hover:opacity-100" onClick={() => setError(null)}>
                dismiss
              </button>
            </div>
          )}
          {view === 'board' && <Board repoId={activeRepo} specs={specs} />}
          {view === 'prompts' && activeRepo && (
            <PromptsPanel repoId={activeRepo} onError={setError} />
          )}
        </main>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header className="glass m-4 mb-0 rounded-2xl px-6 py-4 flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl joule-gradient joule-glow" />
      <div>
        <h1 className="text-lg font-semibold tracking-tight">AI Pilot</h1>
        <p className="text-xs text-joule-muted">
          SPEC → REQUIREMENTS → DESIGN → DEVELOP → TEST → BUILD → DEPLOY → OPS
        </p>
      </div>
    </header>
  );
}

function Sidebar({
  repos,
  activeRepo,
  onSelect,
  onAdd,
  onBrowse,
}: {
  repos: RepoEntry[];
  activeRepo: string | null;
  onSelect: (id: string) => void;
  onAdd: (path: string) => void;
  onBrowse: () => Promise<void>;
}) {
  const [path, setPath] = useState('');
  const [manual, setManual] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  return (
    <aside className="glass rounded-2xl w-64 p-4 flex flex-col gap-3 shrink-0">
      <h2 className="text-xs uppercase tracking-widest text-joule-muted">Repositories</h2>
      <div className="flex flex-col gap-1.5 overflow-auto">
        {repos.length === 0 && <p className="text-sm text-joule-muted">No repos yet.</p>}
        {repos.map((r) => (
          <button
            key={r.id}
            onClick={() => onSelect(r.id)}
            className={`text-left rounded-lg px-3 py-2 text-sm transition ${
              activeRepo === r.id ? 'joule-gradient text-white joule-glow' : 'hover:bg-white/5'
            }`}
          >
            <div className="font-medium truncate">{r.name}</div>
            <div className="text-[11px] opacity-70 truncate">{r.path}</div>
          </button>
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-2">
        <button
          disabled={browsing}
          onClick={async () => {
            setBrowsing(true);
            try {
              await onBrowse();
            } finally {
              setBrowsing(false);
            }
          }}
          className="joule-gradient rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-60 flex items-center justify-center gap-2"
        >
          <FolderIcon />
          {browsing ? 'Opening Finder…' : 'Add repo'}
        </button>

        <button
          onClick={() => setManual((m) => !m)}
          className="text-[11px] text-joule-muted hover:text-joule-ink self-center"
        >
          {manual ? 'hide manual entry' : 'or enter a path manually'}
        </button>

        {manual && (
          <div className="flex flex-col gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/repo"
              className="bg-black/30 rounded-lg px-3 py-2 text-sm outline-none border border-white/10 focus:border-joule-purple"
            />
            <button
              onClick={() => {
                if (path.trim()) {
                  onAdd(path.trim());
                  setPath('');
                }
              }}
              className="rounded-lg bg-white/10 hover:bg-white/15 px-3 py-2 text-sm"
            >
              Add by path
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NewSpec({ onCreate }: { onCreate: (ticketId: string, title: string) => void }) {
  const [ticketId, setTicketId] = useState('');
  const [title, setTitle] = useState('');
  return (
    <div className="glass rounded-2xl p-3 flex gap-2 items-center">
      <input
        value={ticketId}
        onChange={(e) => setTicketId(e.target.value)}
        placeholder="TICKET-123"
        className="bg-black/30 rounded-lg px-3 py-2 text-sm outline-none border border-white/10 focus:border-joule-purple w-36"
      />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Feature title"
        className="bg-black/30 rounded-lg px-3 py-2 text-sm outline-none border border-white/10 focus:border-joule-purple flex-1"
      />
      <button
        onClick={() => {
          if (ticketId.trim() && title.trim()) {
            onCreate(ticketId.trim(), title.trim());
            setTicketId('');
            setTitle('');
          }
        }}
        className="joule-gradient rounded-lg px-4 py-2 text-sm font-medium text-white"
      >
        Create spec
      </button>
    </div>
  );
}

function Board({ repoId, specs }: { repoId: string | null; specs: SpecFile[] }) {
  if (!repoId) {
    return (
      <div className="glass rounded-2xl flex-1 grid place-items-center text-joule-muted">
        Add or select a repository to begin.
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-x-auto">
      <div className="grid grid-flow-col auto-cols-[minmax(220px,1fr)] gap-3 h-full">
        {STAGE_IDS.map((stageId) => (
          <Lane key={stageId} stageId={stageId} repoId={repoId} specs={specs} />
        ))}
      </div>
    </div>
  );
}

/** A spec sits in the lane of its current (furthest non-complete) stage. */
function currentStageId(spec: SpecFile): StageId {
  for (const stage of spec.stages) {
    if (stage.gate.status !== 'approved') return stage.id;
  }
  return spec.stages[spec.stages.length - 1].id;
}

function Lane({
  stageId,
  repoId,
  specs,
}: {
  stageId: StageId;
  repoId: string;
  specs: SpecFile[];
}) {
  const inLane = useMemo(
    () => specs.filter((s) => currentStageId(s) === stageId),
    [specs, stageId]
  );
  return (
    <div className="glass rounded-2xl p-3 flex flex-col gap-2 min-h-0">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold tracking-widest text-joule-muted">
          {STAGE_LABELS[stageId]}
        </span>
        <span className="text-[11px] rounded-full bg-white/10 px-2 py-0.5">{inLane.length}</span>
      </div>
      <div className="flex flex-col gap-2 overflow-auto">
        {inLane.map((spec) => (
          <SpecCard key={spec.ticketId} repoId={repoId} spec={spec} stageId={stageId} />
        ))}
      </div>
    </div>
  );
}

const GATE_STYLES: Record<string, string> = {
  not_ready: 'bg-white/10 text-joule-muted',
  pending_review: 'bg-amber-400/20 text-amber-200',
  approved: 'bg-emerald-400/20 text-emerald-200',
  rejected: 'bg-red-400/20 text-red-200',
};

function SpecCard({ repoId, spec, stageId }: { repoId: string; spec: SpecFile; stageId: StageId }) {
  const stage = spec.stages.find((s) => s.id === stageId)!;
  const approvedCount = spec.stages.filter((s) => s.gate.status === 'approved').length;
  const pct = Math.round((approvedCount / spec.stages.length) * 100);

  return (
    <div className="rounded-xl bg-white/5 border border-white/10 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-sm">{spec.ticketId}</span>
        <StatusDot stage={stage} />
      </div>
      <div className="text-xs text-joule-muted truncate" title={spec.title}>
        {spec.title}
      </div>

      <div className="h-1.5 rounded-full bg-black/40 overflow-hidden">
        <div className="h-full joule-gradient" style={{ width: `${pct}%` }} />
      </div>

      <div className="flex items-center gap-2 text-[11px]">
        <span className={`rounded-full px-2 py-0.5 ${GATE_STYLES[stage.gate.status]}`}>
          {stage.gate.status.replace('_', ' ')}
        </span>
        {stage.aiCapability === 'stub' && (
          <span className="rounded-full px-2 py-0.5 bg-white/10 text-joule-muted">stub</span>
        )}
      </div>

      {stage.gate.status === 'pending_review' && (
        <GateActions repoId={repoId} ticketId={spec.ticketId} stageId={stageId} />
      )}
      {stage.gate.status === 'rejected' && stage.gate.comment && (
        <p className="text-[11px] text-red-200/80 italic">“{stage.gate.comment}”</p>
      )}
    </div>
  );
}

function StatusDot({ stage }: { stage: Stage }) {
  const color =
    stage.aiStatus === 'done'
      ? 'bg-emerald-400'
      : stage.aiStatus === 'in_progress'
        ? 'bg-amber-400'
        : stage.aiStatus === 'stubbed'
          ? 'bg-white/30'
          : 'bg-joule-blue';
  return <span className={`w-2.5 h-2.5 rounded-full ${color}`} title={stage.aiStatus} />;
}

function GateActions({
  repoId,
  ticketId,
  stageId,
}: {
  repoId: string;
  ticketId: string;
  stageId: StageId;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');

  if (rejecting) {
    return (
      <div className="flex flex-col gap-1.5">
        <input
          autoFocus
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Why reject?"
          className="bg-black/30 rounded-lg px-2 py-1 text-xs outline-none border border-white/10"
        />
        <div className="flex gap-1.5">
          <button
            className="flex-1 rounded-lg bg-red-500/80 text-white text-xs py-1"
            onClick={() => api.reject(repoId, ticketId, stageId, comment)}
          >
            Confirm reject
          </button>
          <button
            className="rounded-lg bg-white/10 text-xs px-2"
            onClick={() => setRejecting(false)}
          >
            cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-1.5">
      <button
        className="flex-1 rounded-lg joule-gradient text-white text-xs py-1 font-medium"
        onClick={() => api.approve(repoId, ticketId, stageId)}
      >
        Approve
      </button>
      <button
        className="rounded-lg bg-white/10 hover:bg-white/15 text-xs px-3"
        onClick={() => setRejecting(true)}
      >
        Reject
      </button>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-xs font-medium transition ${
        active ? 'joule-gradient text-white' : 'text-joule-muted hover:text-joule-ink'
      }`}
    >
      {children}
    </button>
  );
}

const SOURCE_BADGE: Record<TemplateSource, { label: string; cls: string }> = {
  'repo-curated': { label: 'curated', cls: 'bg-emerald-400/20 text-emerald-200' },
  'repo-draft': { label: 'draft', cls: 'bg-amber-400/20 text-amber-200' },
  'blueprint-default': { label: 'blueprint', cls: 'bg-white/10 text-joule-muted' },
};

function PromptsPanel({ repoId, onError }: { repoId: string; onError: (e: string) => void }) {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [expanded, setExpanded] = useState<StageId | null>(null);
  const [curating, setCurating] = useState<StageId | null>(null);

  const load = useCallback(async () => {
    try {
      setTemplates(await api.listTemplates(repoId));
    } catch (e) {
      onError(String((e as Error).message));
    }
  }, [repoId, onError]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="glass rounded-2xl flex-1 flex flex-col gap-0 overflow-auto">
      <div className="px-5 pt-4 pb-2 flex items-center gap-2">
        <h2 className="text-xs uppercase tracking-widest text-joule-muted font-semibold">
          Prompt Templates
        </h2>
        <span className="text-[11px] text-joule-muted ml-auto">
          Curate drafts after reviewing — curated templates are preferred over blueprint defaults
        </span>
      </div>
      {templates.map((tpl) => {
        const badge = SOURCE_BADGE[tpl.source];
        const isExpanded = expanded === tpl.stageId;
        return (
          <div key={tpl.stageId} className="border-t border-white/5">
            <div
              className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-white/3 transition"
              onClick={() => setExpanded(isExpanded ? null : tpl.stageId)}
            >
              <span className="text-sm font-medium w-28">{STAGE_LABELS[tpl.stageId]}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${badge.cls}`}>
                {badge.label}
              </span>
              {tpl.source === 'repo-draft' && (
                <button
                  disabled={curating === tpl.stageId}
                  onClick={async (e) => {
                    e.stopPropagation();
                    setCurating(tpl.stageId);
                    try {
                      await api.markTemplateCurated(repoId, tpl.stageId);
                      await load();
                    } catch (err) {
                      onError(String((err as Error).message));
                    } finally {
                      setCurating(null);
                    }
                  }}
                  className="ml-auto rounded-lg joule-gradient text-white text-[11px] px-3 py-1 disabled:opacity-60"
                >
                  {curating === tpl.stageId ? 'Marking…' : 'Mark curated'}
                </button>
              )}
              <span className="ml-auto text-joule-muted text-xs">{isExpanded ? '▲' : '▼'}</span>
            </div>
            {isExpanded && (
              <pre className="mx-5 mb-3 rounded-xl bg-black/30 border border-white/5 px-4 py-3 text-[11px] text-joule-ink/80 overflow-auto whitespace-pre-wrap max-h-64">
                {tpl.content}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
