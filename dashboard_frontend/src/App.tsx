import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import { api, connectWs } from './api';
import {
  STAGE_IDS,
  STAGE_LABELS,
  type Artifact,
  type DeployChecklistArtifact,
  type OpsReportArtifact,
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

  // Fallback polling: re-fetch every 5s to catch any missed WS events.
  useEffect(() => {
    if (!activeRepo) return;
    const id = setInterval(() => refreshSpecs(activeRepo), 5000);
    return () => clearInterval(id);
  }, [activeRepo, refreshSpecs]);

  return (
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
      <main className="flex-1 flex flex-col gap-4 p-4 overflow-hidden">
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
  );
}

function Header({
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
  const [showAdd, setShowAdd] = useState(false);
  const [path, setPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const active = repos.find((r) => r.id === activeRepo);

  return (
    <header className="glass m-4 mb-0 rounded-2xl px-6 py-3 flex items-center gap-4">
      <div className="w-8 h-8 rounded-xl joule-gradient joule-glow shrink-0" />
      <div className="shrink-0">
        <h1 className="text-base font-semibold tracking-tight leading-tight">AI Pilot</h1>
        <p className="text-[11px] text-joule-muted leading-tight">
          SPEC → REQ → DESIGN → DEV → TEST → BUILD → DEPLOY → OPS
        </p>
      </div>

      <div className="w-px h-8 bg-white/10 mx-1 shrink-0" />

      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="text-[11px] text-joule-muted uppercase tracking-widest shrink-0">Repo</span>

        {repos.length > 0 ? (
          <RepoDropdown repos={repos} activeRepo={activeRepo} onSelect={onSelect} />
        ) : (
          <span className="text-sm text-joule-muted italic">No repos yet</span>
        )}

        {active && (
          <span className="text-[11px] text-joule-muted truncate opacity-60 hidden sm:block" title={active.path}>
            {active.path}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {showAdd ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && path.trim()) {
                  onAdd(path.trim());
                  setPath('');
                  setShowAdd(false);
                }
                if (e.key === 'Escape') {
                  setPath('');
                  setShowAdd(false);
                }
              }}
              placeholder="/path/to/repo"
              className="bg-black/30 rounded-lg px-3 py-1.5 text-sm outline-none border border-white/10 focus:border-joule-purple w-52"
            />
            <button
              onClick={() => {
                if (path.trim()) {
                  onAdd(path.trim());
                  setPath('');
                  setShowAdd(false);
                }
              }}
              className="rounded-lg joule-gradient text-white text-sm px-3 py-1.5 font-medium"
            >
              Add
            </button>
            <button
              onClick={() => { setPath(''); setShowAdd(false); }}
              className="text-joule-muted hover:text-joule-ink text-sm px-2"
            >
              ✕
            </button>
          </div>
        ) : (
          <>
            <button
              disabled={browsing}
              onClick={async () => {
                setBrowsing(true);
                try { await onBrowse(); } finally { setBrowsing(false); }
              }}
              className="joule-gradient rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 flex items-center gap-1.5"
            >
              <FolderIcon />
              {browsing ? 'Opening…' : 'Add repo'}
            </button>
            <button
              onClick={() => setShowAdd(true)}
              className="text-[11px] text-joule-muted hover:text-joule-ink"
            >
              or path
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function RepoDropdown({
  repos,
  activeRepo,
  onSelect,
}: {
  repos: RepoEntry[];
  activeRepo: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const active = repos.find((r) => r.id === activeRepo);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest('[data-repo-dropdown]');
      if (!el) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  function handleOpen() {
    if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  }

  return (
    <div data-repo-dropdown="">
      <button
        ref={btnRef}
        onClick={handleOpen}
        className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-lg pl-3 pr-2.5 py-1.5 text-sm text-joule-ink hover:border-white/20 focus:border-joule-purple outline-none transition min-w-[180px] max-w-[280px]"
      >
        <span className="truncate flex-1 text-left">{active?.name ?? 'Select repo'}</span>
        <span className={`text-[10px] text-joule-muted transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {open && rect && createPortal(
        <div
          data-repo-dropdown=""
          style={{ position: 'fixed', top: rect.bottom + 6, left: rect.left, minWidth: rect.width, zIndex: 9999 }}
          className="glass rounded-xl overflow-hidden min-w-[240px] max-w-[320px] py-1 shadow-xl"
        >
          {repos.map((r) => (
            <button
              key={r.id}
              onClick={() => { onSelect(r.id); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm transition flex flex-col gap-0.5 ${
                r.id === activeRepo
                  ? 'joule-gradient text-white'
                  : 'hover:bg-white/5 text-joule-ink'
              }`}
            >
              <span className="font-medium truncate">{r.name}</span>
              <span className={`text-[11px] truncate ${r.id === activeRepo ? 'opacity-70' : 'text-joule-muted'}`}>
                {r.path}
              </span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
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

function currentStageId(spec: SpecFile): StageId {
  for (const stage of spec.stages) {
    // A stage is "current" if its gate isn't approved yet, OR if it's still
    // being worked on (aiStatus != done/stubbed) — develop Phase B can still
    // be in progress even after the Phase A gate is approved.
    if (stage.gate.status !== 'approved' || (stage.aiStatus !== 'done' && stage.aiStatus !== 'stubbed')) {
      return stage.id;
    }
  }
  return spec.stages[spec.stages.length - 1].id;
}

const GATE_STYLES: Record<string, string> = {
  not_ready: 'bg-white/10 text-joule-muted',
  pending_review: 'bg-amber-400/20 text-amber-200',
  approved: 'bg-emerald-400/20 text-emerald-200',
  rejected: 'bg-red-400/20 text-red-200',
  needs_revision: 'bg-orange-400/20 text-orange-200',
};

function Board({ repoId, specs }: { repoId: string | null; specs: SpecFile[] }) {
  if (!repoId) {
    return (
      <div className="glass rounded-2xl flex-1 grid place-items-center text-joule-muted">
        Add or select a repository to begin.
      </div>
    );
  }
  if (specs.length === 0) {
    return (
      <div className="glass rounded-2xl flex-1 grid place-items-center text-joule-muted text-sm">
        No specs yet — create one above.
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto flex flex-col gap-2">
      {specs.map((spec) => (
        <SpecRow key={spec.ticketId} repoId={repoId} spec={spec} />
      ))}
    </div>
  );
}

function SpecRow({ repoId, spec }: { repoId: string; spec: SpecFile }) {
  const [expanded, setExpanded] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewStage, setReviewStage] = useState<StageId | null>(null);

  const activeStageId = currentStageId(spec);
  const activeStage = spec.stages.find((s) => s.id === activeStageId)!;
  const approvedCount = spec.stages.filter((s) => s.gate.status === 'approved').length;
  const pct = Math.round((approvedCount / spec.stages.length) * 100);
  const hasPending = spec.stages.some((s) => s.gate.status === 'pending_review');

  return (
    <div className={`glass rounded-2xl overflow-hidden transition-all ${hasPending ? 'border border-amber-400/30' : 'border border-transparent'}`}>
      {/* collapsed header — always visible */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/3 transition text-left"
      >
        <span className={`text-[10px] text-joule-muted transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`}>▶</span>

        <span className="font-semibold text-sm shrink-0 w-28 truncate">{spec.ticketId}</span>

        <span className="text-sm text-joule-ink truncate flex-1 min-w-0">{spec.title}</span>

        {/* mini timeline — dots only */}
        <div className="hidden md:flex items-center gap-1 shrink-0">
          {spec.stages.map((s) => (
            <StageDot key={s.id} stage={s} active={s.id === activeStageId} />
          ))}
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className={`text-[11px] rounded-full px-2 py-0.5 ${GATE_STYLES[activeStage.gate.status]}`}>
            {STAGE_LABELS[activeStageId]}
          </span>
          {hasPending && (
            <span className="text-[11px] rounded-full px-2 py-0.5 bg-amber-400/20 text-amber-200">review</span>
          )}
        </div>

        <div className="w-16 shrink-0">
          <div className="h-1 rounded-full bg-black/40 overflow-hidden">
            <div className="h-full joule-gradient transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-[10px] text-joule-muted text-right mt-0.5">{pct}%</div>
        </div>
      </button>

      {/* expanded: full timeline */}
      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-4 border-t border-white/5">
          <StageTimeline
            spec={spec}
            repoId={repoId}
            activeStageId={activeStageId}
            onReview={(stageId) => { setReviewStage(stageId); setReviewOpen(true); }}
          />
          {activeStageId === 'develop' && (
            <DevelopSubtasks repoId={repoId} spec={spec} />
          )}
        </div>
      )}

      {reviewOpen && reviewStage && (
        <ReviewModal
          repoId={repoId}
          ticketId={spec.ticketId}
          title={spec.title}
          stageId={reviewStage}
          onClose={() => { setReviewOpen(false); setReviewStage(null); }}
        />
      )}
    </div>
  );
}

function StageDot({ stage, active }: { stage: Stage; active: boolean }) {
  const isApproved = stage.gate.status === 'approved';
  const isPending = stage.gate.status === 'pending_review';
  const isRejected = stage.gate.status === 'rejected' || stage.gate.status === 'needs_revision';

  const cls = isApproved
    ? 'bg-emerald-400'
    : isPending
      ? 'bg-amber-400 animate-pulse'
      : isRejected
        ? 'bg-red-400'
        : active
          ? 'bg-joule-blue'
          : 'bg-white/15';

  return <span className={`w-2 h-2 rounded-full ${cls}`} title={stage.id} />;
}

function StageTimeline({
  spec,
  repoId,
  activeStageId,
  onReview,
}: {
  spec: SpecFile;
  repoId: string;
  activeStageId: StageId;
  onReview: (stageId: StageId) => void;
}) {
  return (
    <div className="pt-3 overflow-x-auto">
      <div className="flex items-start min-w-max gap-0">
        {spec.stages.map((stage, i) => {
          const isApproved = stage.gate.status === 'approved';
          const isPending = stage.gate.status === 'pending_review';
          const isRejected = stage.gate.status === 'rejected';
          const isRevision = stage.gate.status === 'needs_revision';
          const isActive = stage.id === activeStageId;
          const isFuture = !isApproved && !isActive;
          const isLast = i === spec.stages.length - 1;

          const nodeColor = isApproved
            ? 'border-emerald-400 bg-emerald-400/20 text-emerald-300'
            : isPending
              ? 'border-amber-400 bg-amber-400/20 text-amber-200'
              : isRejected
                ? 'border-red-400 bg-red-400/20 text-red-300'
                : isRevision
                  ? 'border-orange-400 bg-orange-400/20 text-orange-200'
                  : isActive
                    ? 'border-joule-blue bg-joule-blue/20 text-joule-blue'
                    : 'border-white/15 bg-white/5 text-joule-muted';

          const lineColor = isApproved ? 'bg-emerald-400/50' : 'bg-white/10';

          return (
            <div key={stage.id} className="flex items-start">
              {/* node + label */}
              <div className="flex flex-col items-center w-20">
                <div className={`w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold ${nodeColor}`}>
                  {isApproved ? '✓' : isRejected ? '✗' : isRevision ? '↩' : isPending ? '…' : (i + 1)}
                </div>
                <span className={`text-[10px] mt-1 text-center leading-tight ${isFuture ? 'text-white/25' : isActive ? 'text-joule-ink' : 'text-joule-muted'}`}>
                  {STAGE_LABELS[stage.id]}
                </span>
                {isActive && (
                  <span className={`text-[10px] mt-0.5 rounded-full px-1.5 py-px ${GATE_STYLES[stage.gate.status]}`}>
                    {stage.gate.status.replace(/_/g, ' ')}
                  </span>
                )}
                {isActive && isPending && (
                  <button
                    onClick={() => onReview(stage.id)}
                    className="mt-1.5 text-[10px] rounded-lg joule-gradient text-white px-2 py-0.5 font-medium"
                  >
                    Review
                  </button>
                )}
                {(isRejected || isRevision) && stage.gate.comment && (
                  <p className="text-[10px] text-red-200/70 italic mt-0.5 text-center max-w-[72px] truncate" title={stage.gate.comment}>
                    "{stage.gate.comment}"
                  </p>
                )}
              </div>

              {/* connector line */}
              {!isLast && (
                <div className={`w-8 h-0.5 mt-4 shrink-0 ${lineColor}`} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DevelopSubtasks({ repoId, spec }: { repoId: string; spec: SpecFile }) {
  const develop = spec.stages.find((s) => s.id === 'develop')!;
  const subtasks = develop.subtasks ?? [];
  const [newDesc, setNewDesc] = useState('');
  const [adding, setAdding] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  const doneCount = subtasks.filter((t) => t.completed).length;

  async function handleToggle(subtaskId: string) {
    setToggling(subtaskId);
    try {
      await api.toggleSubtask(repoId, spec.ticketId, subtaskId);
    } finally {
      setToggling(null);
    }
  }

  async function handleAdd() {
    const desc = newDesc.trim();
    if (!desc) return;
    setAdding(true);
    try {
      await api.setSubtasks(repoId, spec.ticketId, [
        ...subtasks.map((t) => ({ description: t.description, prompt: t.prompt, requirementRef: t.requirementRef })),
        { description: desc },
      ]);
      setNewDesc('');
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-white/5 pt-2 mt-0.5">
      <div className="flex items-center justify-between text-[11px] text-joule-muted">
        <span>Subtasks</span>
        {subtasks.length > 0 && (
          <span>
            {doneCount}/{subtasks.length}
          </span>
        )}
      </div>

      {subtasks.length > 0 && (
        <div className="flex flex-col gap-1">
          {subtasks.map((task) => (
            <label
              key={task.id}
              className={`flex items-start gap-2 text-[11px] cursor-pointer rounded-lg px-2 py-1 hover:bg-white/5 transition ${
                task.completed ? 'text-joule-muted line-through' : 'text-joule-ink'
              }`}
            >
              <input
                type="checkbox"
                checked={task.completed}
                disabled={toggling === task.id}
                onChange={() => handleToggle(task.id)}
                className="mt-0.5 shrink-0 accent-joule-purple"
              />
              <span className="break-words min-w-0">{task.description}</span>
            </label>
          ))}
        </div>
      )}

      {subtasks.length > 0 && (
        <div className="h-1 rounded-full bg-black/40 overflow-hidden">
          <div
            className="h-full joule-gradient transition-all"
            style={{ width: subtasks.length ? `${Math.round((doneCount / subtasks.length) * 100)}%` : '0%' }}
          />
        </div>
      )}

      <div className="flex gap-1.5 mt-0.5">
        <input
          value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          placeholder="Add a subtask..."
          className="flex-1 bg-black/30 rounded-lg px-2 py-1 text-[11px] outline-none border border-white/10 focus:border-joule-purple"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newDesc.trim()}
          className="rounded-lg bg-white/10 hover:bg-white/15 text-[11px] px-2 py-1 disabled:opacity-50"
        >
          +
        </button>
      </div>
    </div>
  );
}

function ReviewModal({
  repoId,
  ticketId,
  title,
  stageId,
  onClose,
}: {
  repoId: string;
  ticketId: string;
  title: string;
  stageId: StageId;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getArtifact(repoId, ticketId, stageId)
      .then((res) => {
        if (!alive) return;
        setContent(res.content);
        setArtifact(res.artifact);
      })
      .catch((e) => alive && setErr(String((e as Error).message)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [repoId, ticketId, stageId]);

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm grid place-items-center p-4"
      onClick={onClose}
    >
      <div
        className="glass rounded-2xl w-[80vw] max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-3 border-b border-white/10 shrink-0">
          <span className="font-semibold text-sm">{ticketId}</span>
          <span className="text-[11px] rounded-full bg-white/10 px-2 py-0.5 text-joule-muted">
            {STAGE_LABELS[stageId]}
          </span>
          <span className="text-xs text-joule-muted truncate" title={title}>
            {title}
          </span>
          {artifact && (
            <span className="text-[10px] rounded-full bg-white/5 px-2 py-0.5 text-joule-muted ml-1">
              {artifact.kind}
            </span>
          )}
          <button
            onClick={onClose}
            className="ml-auto text-joule-muted hover:text-joule-ink text-lg leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5">
          {loading && <p className="text-sm text-joule-muted">Loading…</p>}
          {err && <p className="text-sm text-red-300">{err}</p>}
          {!loading && !err && content !== null && artifact?.kind === 'deploy-checklist' && (
            <DeployChecklistView artifact={artifact as DeployChecklistArtifact} content={content} />
          )}
          {!loading && !err && content !== null && artifact?.kind === 'ops-report' && (
            <OpsReportView artifact={artifact as OpsReportArtifact} content={content} />
          )}
          {!loading && !err && content !== null && (!artifact || artifact.kind === 'markdown') && (
            <div className="md-body">
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>
          )}
        </div>

        <div className="border-t border-white/10 px-5 py-3 shrink-0">
          <GateActions repoId={repoId} ticketId={ticketId} stageId={stageId} onDone={onClose} />
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Render a deploy-checklist artifact: shows each item with governance flags. */
function DeployChecklistView({
  artifact,
  content,
}: {
  artifact: DeployChecklistArtifact;
  content: string;
}) {
  const GOVERNANCE_BADGE: Record<string, string> = {
    pci: 'bg-yellow-400/20 text-yellow-200',
    gdpr: 'bg-purple-400/20 text-purple-200',
    none: '',
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-xs text-joule-muted">Status:</span>
        <span className="text-xs rounded-full bg-white/10 px-2 py-0.5">{artifact.status}</span>
        {artifact.rollbackCriteria && (
          <span className="text-xs text-amber-300/80 italic ml-auto">↩ {artifact.rollbackCriteria}</span>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {artifact.items.map((item) => (
          <li key={item.id} className="flex items-start gap-2 rounded-lg bg-white/5 px-3 py-2">
            <span
              className={`mt-0.5 w-4 h-4 rounded shrink-0 flex items-center justify-center text-[10px] ${item.checked ? 'joule-gradient text-white' : 'border border-white/20'}`}
            >
              {item.checked ? '✓' : ''}
            </span>
            <span className={`text-sm flex-1 ${item.checked ? 'line-through text-joule-muted' : ''}`}>
              {item.description}
            </span>
            {item.governanceFlag !== 'none' && (
              <span className={`text-[10px] rounded-full px-1.5 py-0.5 shrink-0 ${GOVERNANCE_BADGE[item.governanceFlag]}`}>
                {item.governanceFlag.toUpperCase()}
              </span>
            )}
          </li>
        ))}
      </ul>
      {content && (
        <details className="text-xs text-joule-muted">
          <summary className="cursor-pointer">Raw markdown</summary>
          <div className="md-body mt-2">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        </details>
      )}
    </div>
  );
}

/** Render an ops-report artifact: surfaces governance flags prominently. */
function OpsReportView({
  artifact,
  content,
}: {
  artifact: OpsReportArtifact;
  content: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-xs text-joule-muted">Log sanitization:</span>
        <span
          className={`text-xs font-semibold rounded-full px-2 py-0.5 ${artifact.logsSanitized ? 'bg-emerald-400/20 text-emerald-200' : 'bg-red-400/20 text-red-300'}`}
        >
          {artifact.logsSanitized ? '✓ Sanitized' : '⚠ NOT SANITIZED'}
        </span>
      </div>
      {!artifact.logsSanitized && (
        <p className="text-xs text-red-300 bg-red-400/10 rounded-lg px-3 py-2">
          Governance: logs must be sanitized before this artifact can be considered complete.
        </p>
      )}
      {artifact.metrics && (
        <div className="grid grid-cols-3 gap-2">
          {artifact.metrics.stageCoverage !== undefined && (
            <div className="rounded-lg bg-white/5 px-3 py-2 text-center">
              <div className="text-lg font-bold">{artifact.metrics.stageCoverage}%</div>
              <div className="text-[10px] text-joule-muted">stage coverage</div>
            </div>
          )}
          {artifact.metrics.cycleTimeMs !== undefined && (
            <div className="rounded-lg bg-white/5 px-3 py-2 text-center">
              <div className="text-lg font-bold">{Math.round(artifact.metrics.cycleTimeMs / 1000 / 60)}m</div>
              <div className="text-[10px] text-joule-muted">cycle time</div>
            </div>
          )}
          {artifact.metrics.buildSuccess !== undefined && (
            <div className="rounded-lg bg-white/5 px-3 py-2 text-center">
              <div className={`text-lg font-bold ${artifact.metrics.buildSuccess ? 'text-emerald-300' : 'text-red-300'}`}>
                {artifact.metrics.buildSuccess ? '✓' : '✗'}
              </div>
              <div className="text-[10px] text-joule-muted">build</div>
            </div>
          )}
        </div>
      )}
      {(artifact.rcaPath || artifact.runbookPath) && (
        <div className="text-xs text-joule-muted flex flex-col gap-1">
          {artifact.rcaPath && <span>RCA: {artifact.rcaPath}</span>}
          {artifact.runbookPath && <span>Runbook: {artifact.runbookPath}</span>}
        </div>
      )}
      <div className="md-body">
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </div>
  );
}

function GateActions({
  repoId,
  ticketId,
  stageId,
  onDone,
}: {
  repoId: string;
  ticketId: string;
  stageId: StageId;
  onDone?: () => void;
}) {
  const [mode, setMode] = useState<'normal' | 'rejecting' | 'revising'>('normal');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      onDone?.();
    } finally {
      setBusy(false);
    }
  }

  function resetMode() {
    setMode('normal');
    setComment('');
  }

  if (mode === 'rejecting' || mode === 'revising') {
    const isReject = mode === 'rejecting';
    return (
      <div className="flex flex-col gap-2">
        <input
          autoFocus
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={isReject ? 'Why reject?' : 'What needs revision?'}
          className="bg-black/30 rounded-lg px-3 py-2 text-sm outline-none border border-white/10 focus:border-joule-purple"
        />
        <div className="flex gap-2">
          <button
            disabled={busy}
            className={`flex-1 rounded-lg text-white text-sm py-2 disabled:opacity-60 ${
              isReject ? 'bg-red-500/80' : 'bg-orange-500/80'
            }`}
            onClick={() =>
              run(() =>
                isReject
                  ? api.reject(repoId, ticketId, stageId, comment)
                  : api.needsRevision(repoId, ticketId, stageId, comment)
              )
            }
          >
            {isReject ? 'Confirm reject' : 'Request revision'}
          </button>
          <button
            className="rounded-lg bg-white/10 text-sm px-3"
            onClick={resetMode}
          >
            cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <button
        disabled={busy}
        className="flex-1 rounded-lg joule-gradient text-white text-sm py-2 font-medium disabled:opacity-60"
        onClick={() => run(() => api.approve(repoId, ticketId, stageId))}
      >
        Approve
      </button>
      <button
        className="rounded-lg bg-orange-400/20 hover:bg-orange-400/30 text-orange-200 text-sm px-4"
        onClick={() => setMode('revising')}
      >
        Revise
      </button>
      <button
        className="rounded-lg bg-white/10 hover:bg-white/15 text-sm px-4"
        onClick={() => setMode('rejecting')}
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
