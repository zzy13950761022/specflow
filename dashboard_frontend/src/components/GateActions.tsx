import { useState } from 'react';
import { api } from '../api';
import type { StageId } from '../types';

export function GateActions({
  repoId,
  ticketId,
  stageId,
  revision,
  onDone,
}: {
  repoId: string;
  ticketId: string;
  stageId: StageId;
  revision: number;
  onDone?: () => void;
}) {
  const [mode, setMode] = useState<'normal' | 'rejecting' | 'revising'>('normal');
  const [comment, setComment] = useState('');
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
  }

  if (mode === 'rejecting' || mode === 'revising') {
    const isReject = mode === 'rejecting';
    return (
      <div className="flex flex-col gap-2">
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <input
          autoFocus
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={isReject ? 'Why reject?' : 'What needs revision?'}
          className="bg-gray-100 rounded-lg px-3 py-2 text-sm outline-none border border-blue-200 focus:border-blue-500"
        />
        <div className="flex gap-2">
          <button
            disabled={busy || !comment.trim()}
            className={`flex-1 rounded-lg text-white text-sm py-2 disabled:opacity-60 ${
              isReject ? 'bg-red-500/80' : 'bg-orange-500/80'
            }`}
            onClick={() =>
              run(() =>
                isReject
                  ? api.reject(repoId, ticketId, stageId, comment, revision)
                  : api.needsRevision(repoId, ticketId, stageId, comment, revision)
              )
            }
          >
            {isReject ? 'Confirm reject' : 'Request revision'}
          </button>
          <button className="rounded-lg bg-white/10 text-sm px-3" onClick={resetMode}>
            cancel
          </button>
        </div>
      </div>
    );
  }

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
