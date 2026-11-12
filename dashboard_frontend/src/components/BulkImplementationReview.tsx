import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '../api';
import type { Subtask } from '../types';
import { Dialog } from './Dialog';

type Reports = Awaited<ReturnType<typeof api.implementationReviews>>;
type Verdict = 'approved' | 'needs_revision' | 'rejected';

export function BulkImplementationReview({ repoId, ticketId, tasks, canReview }: { repoId: string; ticketId: string; tasks: Subtask[]; canReview: boolean }) {
  const [open, setOpen] = useState(false);
  const [reports, setReports] = useState<Reports | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const reviewedTasks = tasks.filter(task => task.review);
  const pending = reports?.filter(report => report.review.status === 'pending_review') ?? [];
  const changed = !!reports && (reports.length !== reviewedTasks.length || reports.some(report => {
    const current = reviewedTasks.find(task => task.id === report.subtaskId)?.review;
    return current?.id !== report.review.id || current.status !== report.review.status;
  }));
  const sourceChanged = pending.some(report => report.sourceChanged);
  const disabled = busy || !reports || !pending.length || changed || !canReview;

  async function load() {
    setBusy(true); setError(null); setReports(null);
    try { setReports(await api.implementationReviews(repoId, ticketId)); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function review(verdict: Verdict) {
    if (disabled || (verdict === 'approved' ? sourceChanged : !comment.trim())) return;
    setBusy(true); setError(null);
    try {
      await api.reviewImplementationBatch(repoId, ticketId, pending.map(report => ({ subtaskId: report.subtaskId, expectedReviewId: report.review.id })), verdict, comment.trim() || undefined);
      setOpen(false); setReports(null); setComment('');
      setNotice(verdict === 'approved' ? 'Approved all ' + pending.length + ' pending implementations.' : 'Returned all ' + pending.length + ' pending implementations for rework.');
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  if (!reviewedTasks.length) return null;
  return <>
    <button className="rounded-lg bg-blue-100 px-3 py-2 text-sm self-start" onClick={() => { setOpen(true); setNotice(''); setComment(''); void load(); }}>Review all reports ({reviewedTasks.length})</button>
    {notice && <p role="status" className="text-sm text-blue-700">{notice}</p>}
    {open && <Dialog title="Implementation reports" busy={busy} onClose={() => setOpen(false)}>
      <div className="dialog-body px-6 py-4 space-y-5">
        <p className="text-sm text-slate-600">Read the reports below, then apply one decision to all pending implementations. You can still review tasks individually outside this dialog.</p>
        {busy && !reports && <p role="status">Loading reports…</p>}
        {reports?.length === 0 && <p>No implementation reports are available.</p>}
        {reports?.map(report => <article key={report.review.id} className="border-b border-blue-100 pb-4">
          <p className="text-xs text-slate-500">{report.subtaskId} · {report.review.status.replaceAll('_', ' ')}</p>
          <div className="md-body"><ReactMarkdown>{report.content}</ReactMarkdown></div>
        </article>)}
      </div>
      <div className="dialog-footer bg-white border-t border-blue-100 px-6 py-4 space-y-3">
        {changed && <p role="status" className="text-sm text-orange-700">Reports changed while you were reviewing. Reload all reports before deciding.</p>}
        {sourceChanged && <p role="status" className="text-sm text-orange-700">Source changed. Submit fresh implementation reports before approving.</p>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {pending.length > 0 && canReview && <>
          <label className="field text-sm">Comment for all pending implementations<textarea rows={2} value={comment} disabled={busy} onChange={event => setComment(event.target.value)} placeholder="Required when requesting changes or rejecting" /></label>
          <p className="text-xs text-slate-500">Requesting changes or rejecting resets pending tasks and their dependents for rework.</p>
          <div className="flex flex-wrap gap-2">
            <button disabled={disabled || sourceChanged} className="rounded-lg joule-gradient text-white px-3 py-2 text-sm disabled:opacity-50" onClick={() => void review('approved')}>Approve all pending ({pending.length})</button>
            <button disabled={disabled || !comment.trim()} className="rounded-lg bg-orange-100 px-3 py-2 text-sm disabled:opacity-50" onClick={() => void review('needs_revision')}>Revise all pending ({pending.length})</button>
            <button disabled={disabled || !comment.trim()} className="rounded-lg bg-red-100 px-3 py-2 text-sm disabled:opacity-50" onClick={() => void review('rejected')}>Reject all pending ({pending.length})</button>
          </div>
        </>}
        <div className="flex justify-end gap-2">
          <button disabled={busy} className="rounded-lg px-3 py-1.5 text-sm hover:bg-blue-50 disabled:opacity-50" onClick={() => void load()}>Reload reports</button>
          <button disabled={busy} className="rounded-lg px-3 py-1.5 text-sm hover:bg-blue-50 disabled:opacity-50" onClick={() => setOpen(false)}>Close</button>
        </div>
      </div>
    </Dialog>}
  </>;
}
