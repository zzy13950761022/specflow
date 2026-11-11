import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AgentSettingsDialog } from './AgentSettingsDialog';
import type { RepoEntry } from '../types';

export function Header({
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
  const [showSettings, setShowSettings] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [path, setPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const active = repos.find((r) => r.id === activeRepo);

  return (
    <header className="glass m-4 mb-0 rounded-2xl px-6 py-3 flex items-center gap-4">
      <div className="w-8 h-8 rounded-xl joule-gradient joule-glow shrink-0" />
      <div className="shrink-0">
        <h1 className="text-base font-semibold tracking-tight leading-tight">AI Pilot</h1>
      </div>

      <div className="w-px h-8 bg-white/10 mx-1 shrink-0" />

      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="text-[11px] text-slate-500 uppercase tracking-widest shrink-0">
          Repo
        </span>

        {repos.length > 0 ? (
          <RepoDropdown repos={repos} activeRepo={activeRepo} onSelect={onSelect} />
        ) : (
          <span className="text-sm text-slate-500 italic">No repos yet</span>
        )}

        {active && (
          <span
            className="text-[11px] text-slate-500 truncate opacity-60 hidden sm:block"
            title={active.path}
          >
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
              className="bg-gray-100 rounded-lg px-3 py-1.5 text-sm outline-none border border-blue-200 focus:border-blue-500 w-52"
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
              onClick={() => {
                setPath('');
                setShowAdd(false);
              }}
              className="text-slate-500 hover:text-gray-800 text-sm px-2"
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
                try {
                  await onBrowse();
                } finally {
                  setBrowsing(false);
                }
              }}
              className="joule-gradient rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 flex items-center gap-1.5"
            >
              <FolderIcon />
              {browsing ? 'Opening…' : 'Add repo'}
            </button>
          </>
        )}
        <button aria-label="Agent settings" title="Agent settings" onClick={() => setShowSettings(true)} className="rounded-lg border border-blue-200 px-3 py-1.5 text-blue-700 hover:bg-blue-50">⚙</button>
        {!showAdd && <button onClick={() => setShowAdd(true)} className="text-[11px] text-slate-500 hover:text-gray-800">or path</button>}
      </div>
      {showSettings && <AgentSettingsDialog onClose={() => setShowSettings(false)} />}
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
        className="flex items-center gap-2 bg-gray-100 border border-blue-200 rounded-lg pl-3 pr-2.5 py-1.5 text-sm text-gray-800 hover:border-blue-300 focus:border-blue-500 outline-none transition min-w-[180px] max-w-[280px]"
      >
        <span className="truncate flex-1 text-left">{active?.name ?? 'Select repo'}</span>
        <span className={`text-[10px] text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}>
          ▼
        </span>
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            data-repo-dropdown=""
            style={{
              position: 'fixed',
              top: rect.bottom + 6,
              left: rect.left,
              minWidth: rect.width,
              zIndex: 9999,
            }}
            className="glass rounded-xl overflow-hidden min-w-[240px] max-w-[320px] py-1 shadow-xl"
          >
            {repos.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  onSelect(r.id);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-sm transition flex flex-col gap-0.5 ${
                  r.id === activeRepo ? 'joule-gradient text-white' : 'hover:bg-blue-50 text-gray-800'
                }`}
              >
                <span className="font-medium truncate">{r.name}</span>
                <span
                  className={`text-[11px] truncate ${r.id === activeRepo ? 'opacity-70' : 'text-slate-500'}`}
                >
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
