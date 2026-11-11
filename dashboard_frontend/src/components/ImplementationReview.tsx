import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '../api';
import type { Subtask } from '../types';

export function ImplementationReview({ repoId, ticketId, task, onDone }: { repoId: string; ticketId: string; task: Subtask; onDone: () => void }) {
  const [report, setReport] = useState<Awaited<ReturnType<typeof api.implementationReview>> | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); } catch (error) { setError(String((error as Error).message)); } finally { setBusy(false); }
  }
  const current = report?.review.id === task.review?.id;
  return (
    <div className="rounded-lg bg-blue-50 p-3 flex flex-col gap-2 text-sm">
      <p>{task.description} · Implementation review: {task.review?.status.replaceAll('_', ' ')}</p>
      <button disabled={busy} className="self-start rounded-lg bg-white px-3 py-1 disabled:opacity-50" onClick={() => run(async () => { setReport(await api.implementationReview(repoId, ticketId, task.id)); })}>Read implementation report</button>
      {report && <div className="md-body max-h-80 overflow-auto"><ReactMarkdown>{report.content}</ReactMarkdown></div>}
      {report?.sourceChanged && <p role="status" className="text-orange-700">Source changed. Submit a fresh implementation review.</p>}
      {current && task.review?.status === 'pending_review' && (
        <div className="flex flex-wrap gap-2">
          <button disabled={busy || report!.sourceChanged} className="rounded-lg joule-gradient text-white px-3 py-1 disabled:opacity-50" onClick={() => run(async () => { await api.reviewImplementation(repoId, ticketId, task.id, report!.review.id, 'approved'); onDone(); })}>Approve implementation</button>
          <input aria-label={'Implementation review comment for ' + task.description} placeholder="Revision or rejection comment" value={comment} onChange={(event) => setComment(event.target.value)} className="flex-1 min-w-40 border border-blue-200 rounded-lg px-2 py-1" />
          <button disabled={busy || !comment.trim()} className="rounded-lg bg-orange-100 px-3 py-1 disabled:opacity-50" onClick={() => run(async () => { await api.reviewImplementation(repoId, ticketId, task.id, report!.review.id, 'needs_revision', comment); onDone(); })}>Revise implementation</button>
          <button disabled={busy || !comment.trim()} className="rounded-lg bg-red-100 px-3 py-1 disabled:opacity-50" onClick={() => run(async () => { await api.reviewImplementation(repoId, ticketId, task.id, report!.review.id, 'rejected', comment); onDone(); })}>Reject implementation</button>
        </div>
      )}
      {error && <p role="alert" className="text-red-600">{error}</p>}
    </div>
  );
}
