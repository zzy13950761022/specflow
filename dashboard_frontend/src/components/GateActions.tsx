import { useState } from 'react';
import { api } from '../api';
import type { InlineAnnotation, StageId } from '../types';

export function GateActions({
  repoId,
  ticketId,
  stageId,
  onDone,
  annotations,
  onAnnotationRemove,
}: {
  repoId: string;
  ticketId: string;
  stageId: StageId;
  onDone?: () => void;
  annotations: InlineAnnotation[];
  onAnnotationRemove: (id: string) => void;
}) {
  const [mode, setMode] = useState<'normal' | 'rejecting' | 'revising'>('normal');
  const [comment, setComment] = useState('');
  const [summary, setSummary] = useState('');
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
    setSummary('');
  }

  // --- Reject mode (unchanged single-input flow) ---
  if (mode === 'rejecting') {
    return (
      <div className="flex flex-col gap-2">
        <input
          autoFocus
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Why reject?"
          className="bg-gray-100 rounded-lg px-3 py-2 text-sm outline-none border border-blue-200 focus:border-blue-500"
        />
        <div className="flex gap-2">
          <button
            disabled={busy}
            className="flex-1 rounded-lg text-white text-sm py-2 disabled:opacity-60 bg-red-500/80"
            onClick={() => run(() => api.reject(repoId, ticketId, stageId, comment))}
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
        });
      }
      if (summary.trim()) {
        parts.push(annotations.length > 0 ? `\nSummary: ${summary.trim()}` : summary.trim());
      }
      return parts.join('\n');
    }

    return (
      <div className="flex flex-col gap-3">
        {/* Annotation list */}
        {annotations.length > 0 && (
          <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
            {annotations.map((a) => (
              <div
                key={a.id}
                className="flex items-start gap-2 bg-orange-50 border border-orange-100 rounded-lg px-3 py-2 text-sm"
              >
                <div className="flex-1 min-w-0">
                  <p className="italic text-slate-500 text-xs truncate">"{a.selectedText}"</p>
                  <p className="text-slate-700 mt-0.5">{a.comment}</p>
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

        {/* Summary textarea + action row */}
        <div className="flex items-end gap-2">
          <textarea
            autoFocus={annotations.length === 0}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Overall revision comment (optional)…"
            rows={2}
            className="flex-1 bg-gray-100 rounded-lg px-3 py-2 text-sm outline-none border border-blue-200 focus:border-blue-500 resize-none"
          />
          <div className="flex flex-col gap-1.5 shrink-0">
            <button
              disabled={busy || !canSubmit}
              className="rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-sm px-4 py-2 font-medium disabled:opacity-50"
              onClick={() => run(() => api.needsRevision(repoId, ticketId, stageId, buildComment()))}
            >
              Request revision
            </button>
            <button
              className="rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm px-4 py-2 text-center"
              onClick={resetMode}
            >
              cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Normal mode ---
  return (
    <div className="flex gap-2 justify-end">
      <button
        disabled={busy}
        className="rounded-lg joule-gradient text-white text-sm px-5 py-2 font-medium disabled:opacity-60"
        onClick={() => run(() => api.approve(repoId, ticketId, stageId))}
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
