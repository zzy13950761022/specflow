import { useState } from 'react';
import { api } from '../api';
import type { InlineAnnotation, StageId } from '../types';

export function GateActions({
  repoId,
  ticketId,
  stageId,
  revision,
  onDone,
  annotations,
  onAnnotationRemove,
}: {
  repoId: string;
  ticketId: string;
  stageId: StageId;
  revision: number;
  onDone?: () => void;
  annotations: InlineAnnotation[];
  onAnnotationRemove: (id: string) => void;
}) {
  const [mode, setMode] = useState<'normal' | 'rejecting' | 'revising'>('normal');
  const [comment, setComment] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone?.();
    } catch (error) {
      setError(String((error as Error).message));
    } finally {
      setBusy(false);
    }
  }

  function resetMode() {
    setMode('normal');
    setComment('');
    setSummary('');
  }

  // --- Reject mode (unchanged single-input flow) ---
  if (mode === 'rejecting') {
    return (
      <div className="flex flex-col gap-2">
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <input
          autoFocus
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Why reject?"
          className="bg-gray-100 rounded-lg px-3 py-2 text-sm outline-none border border-blue-200 focus:border-blue-500"
        />
        <div className="flex gap-2">
          <button
            disabled={busy || !comment.trim()}
            className="flex-1 rounded-lg text-white text-sm py-2 disabled:opacity-60 bg-red-500/80"
            onClick={() => run(() => api.reject(repoId, ticketId, stageId, comment, revision))}
          >
            Confirm reject
          </button>
          <button className="rounded-lg bg-white/10 text-sm px-3" onClick={resetMode}>
            cancel
          </button>
        </div>
      </div>
    );
  }

  // --- Revising mode: annotation list + summary + actions ---
  if (mode === 'revising') {
    const canSubmit = annotations.length > 0 || summary.trim().length > 0;

    function buildComment(): string {
      const parts: string[] = [];
      if (annotations.length > 0) {
        parts.push('[Inline annotations]');
        annotations.forEach((a, i) => {
          parts.push(`${i + 1}. "${a.selectedText}" → ${a.comment}`);
          if (a.contextSnippet) parts.push(`   [in: "${a.contextSnippet}"]`);
        });
      }
      if (summary.trim()) {
        parts.push(annotations.length > 0 ? `\nSummary: ${summary.trim()}` : summary.trim());
      }
      return parts.join('\n');
    }

    return (
      <div className="flex flex-col gap-3">
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {/* Annotation list */}
        {annotations.length > 0 && (
          <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
            {annotations.map((a) => (
              <div
                key={a.id}
                className="flex items-start gap-1.5 bg-orange-50 border border-orange-100 rounded-lg px-2.5 py-1.5 text-sm max-w-80 min-w-0"
              >
                <div className="flex flex-col min-w-0 flex-1">
                  <p className="italic text-slate-400 text-xs truncate">"{a.selectedText}"</p>
                  <p className="text-slate-700 text-sm truncate">{a.comment}</p>
                </div>
                <button
                  onClick={() => onAnnotationRemove(a.id)}
                  className="shrink-0 text-slate-400 hover:text-red-500 text-xs mt-0.5"
                  title="Remove annotation"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Summary + action row — all on one line */}
        <div className="flex items-center gap-2">
          <input
            autoFocus={annotations.length === 0}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Overall revision comment (optional)…"
            className="flex-1 bg-gray-100 rounded-lg px-3 py-2 text-sm outline-none border border-blue-200 focus:border-blue-500"
          />
          <button
            disabled={busy || !canSubmit}
            className="shrink-0 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-sm px-4 py-2 font-medium disabled:opacity-50 whitespace-nowrap"
            onClick={() => run(() => api.needsRevision(repoId, ticketId, stageId, buildComment(), revision))}
          >
            Request revision
          </button>
          <button
            className="shrink-0 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm px-4 py-2"
            onClick={resetMode}
          >
            cancel
          </button>
        </div>
      </div>
    );
  }

  // --- Normal mode ---
  return (
    <div className="flex gap-2 justify-end flex-wrap">
      {error && <p role="alert" className="w-full text-sm text-red-600">{error}</p>}
      <button
        disabled={busy}
        className="rounded-lg joule-gradient text-white text-sm px-5 py-2 font-medium disabled:opacity-60"
        onClick={() => run(() => api.approve(repoId, ticketId, stageId, revision))}
      >
        Approve
      </button>
      <button
        className="relative rounded-lg bg-orange-100 hover:bg-orange-200 text-orange-700 text-sm px-4 py-2 font-medium"
        onClick={() => setMode('revising')}
      >
        Revise
        {annotations.length > 0 && (
          <span className="absolute -top-1.5 -right-1.5 bg-orange-500 text-white text-[10px] rounded-full min-w-[16px] h-4 inline-flex items-center justify-center px-1 leading-none">
            {annotations.length}
          </span>
        )}
      </button>
      <button
        className="rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm px-4 py-2 font-medium"
        onClick={() => setMode('rejecting')}
      >
        Reject
      </button>
    </div>
  );
}
