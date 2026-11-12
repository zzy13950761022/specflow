import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { SpecFile, Subtask } from '../types';
import { taskTitle } from '../lib/implementation-report';
import { ImplementationReportContent } from './ImplementationReportContent';
import { Dialog } from './Dialog';

export function reviewLabel(task: Subtask) {
  if (task.review) return { approved: 'Approved', pending_review: 'Pending review', needs_revision: 'Needs revision', rejected: 'Rejected' }[task.review.status];
  const last = task.reviewHistory?.at(-1);
  if (!task.completed && last && last.status !== 'approved') return last.status === 'rejected' ? 'Rejected' : 'Needs revision';
  return task.completed ? 'Awaiting report' : task.status === 'running' ? 'In progress' : 'Not started';
}

export function ImplementationReview({ repoId, ticketId, task, spec, position, total, onPrevious, onNext, onApproved, onBusy, onToggle, taskBusy }: {
  repoId: string; ticketId: string; task: Subtask; spec: SpecFile; position: number; total: number;
  onPrevious: () => void; onNext: () => void; onApproved: (spec: SpecFile) => void; onBusy: (busy: boolean) => void; onToggle: () => void; taskBusy: boolean;
}) {
  const [report, setReport] = useState<Awaited<ReturnType<typeof api.implementationReview>> | null>(null);
  const [tab, setTab] = useState<'report' | 'requirements' | 'history'>(task.review ? 'report' : 'requirements');
  const [mode, setMode] = useState<'needs_revision' | 'rejected' | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const body = useRef<HTMLDivElement>(null);
  async function load() {
    const id = ++request.current;
    setLoading(true); setError(null); setReport(null);
    try { const value = await api.implementationReview(repoId, ticketId, task.id); if (request.current === id) setReport(value); }
    catch (error) { if (request.current === id) setError((error as Error).message); }
    finally { if (request.current === id) setLoading(false); }
  }
  useEffect(() => {
    if (task.review) void load();
    return () => { request.current++; };
  }, [repoId, ticketId, task.id, task.review?.id]);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
    // Switching tasks/tabs starts at the report header without bringing the handoff back.
    const detail = body.current?.closest('.implementation-detail');
    const scroller = detail?.closest('.stage-content');
    if (detail && scroller) {
      const offset = detail.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      if (offset < 0) scroller.scrollTop += offset;
    }
  }, [tab]);
  const current = report?.review.id === task.review?.id && report?.review.status === task.review?.status;
  const canReview = current && task.review?.status === 'pending_review' && spec.currentStageId === 'develop';
  const criterion = spec.acceptanceCriteria.find(item => item.id === task.requirementRef);
  async function decide(verdict: 'approved' | 'needs_revision' | 'rejected') {
    if (!canReview || busy || (verdict === 'approved' ? report?.sourceChanged : !comment.trim())) return;
    setBusy(true); onBusy(true); setError(null);
    try {
      const updated = await api.reviewImplementation(repoId, ticketId, task.id, report!.review.id, verdict, verdict === 'approved' ? undefined : comment.trim());
      setReport(previous => previous ? { ...previous, review: { ...previous.review, status: verdict } } : previous);
      setMode(null); setComment('');
      if (verdict === 'approved') onApproved(updated);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); onBusy(false); }
  }
  const canToggle = spec.currentStageId === 'develop' && spec.stages[3].gate.status === 'approved' && spec.execution.status !== 'paused' && !spec.automation?.enabled && !task.review;
  const history = [...(task.reviewHistory ?? []), ...(task.review ? [task.review] : [])];
  return <section className="implementation-detail" aria-label="Selected task detail">
    <div className="implementation-detail-head">
      <p className="implementation-eyebrow">{task.id}{task.requirementRef ? ' / ' + task.requirementRef : ''}</p>
      <div className="implementation-title"><h2>{taskTitle(task)}</h2><span className={'task-status task-status-' + reviewLabel(task).toLowerCase().replaceAll(' ', '-')}>{reviewLabel(task)}</span></div>
      <p className="implementation-meta">{task.files.length} declared files · {task.completed ? 'Implementation complete' : task.status === 'running' ? 'Implementation in progress' : 'Implementation pending'}{task.review ? ' · Report revision ' + task.review.developRevision : ''}</p>
      <div className="implementation-tabs" role="tablist" aria-label="Task details">
        {(['report', 'requirements', 'history'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{value === 'report' ? 'Implementation report' : value === 'requirements' ? 'Task requirements' : 'Review history'}</button>)}
      </div>
    </div>
    <div ref={body} className="implementation-detail-body" role="tabpanel" tabIndex={0}>
      {tab === 'report' && <>
        {loading && <p role="status">Loading implementation report…</p>}
        {!loading && !task.review && <div className="implementation-empty"><h3>{task.completed ? 'Ready to submit for review' : 'No implementation report yet'}</h3><p>{task.completed ? 'Submit the completed implementation to create its review reports.' : 'The report will appear after implementation is completed and submitted.'}</p></div>}
        {report && <ImplementationReportContent content={report.content} />}
      </>}
      {tab === 'requirements' && <div className="implementation-requirements"><h3>Full task instructions</h3><p>{task.description}</p>{task.prompt && <p>{task.prompt}</p>}{criterion && <><h3>{criterion.id} · Acceptance criterion</h3><dl><dt>Given</dt><dd>{criterion.given}</dd><dt>When</dt><dd>{criterion.when}</dd><dt>Then</dt><dd>{criterion.then}</dd></dl></>}<h3>Declared files</h3>{task.files.length ? <ul>{task.files.map(file => <li key={file}><code>{file}</code></li>)}</ul> : <p>No files declared.</p>}<h3>Dependencies</h3><p>{task.dependsOn.map(id => taskTitle(spec.stages[3].subtasks?.find(item => item.id === id) ?? { description: id })).join(' · ') || 'No dependencies.'}</p></div>}
      {tab === 'history' && <div className="implementation-history"><h3>Review history</h3>{history.length ? history.slice().reverse().map((entry, index) => <article key={entry.id + index}><strong>{entry.status.replaceAll('_', ' ')}</strong><small>Plan revision {entry.developRevision} · attempt {entry.taskAttempt} · {new Date(entry.reviewedAt ?? entry.submittedAt).toLocaleString()}</small>{entry.comment && <p>{entry.comment}</p>}</article>) : <p>No reviews submitted yet.</p>}</div>}
    </div>
    <footer className="implementation-review-footer">
      {error && <p role="alert" className="implementation-error">{error}</p>}
      {report?.sourceChanged && <p role="status" className="implementation-error">Source changed. Submit fresh implementation reports before approving.</p>}
      {report && !current && task.review?.status === 'pending_review' && <p role="status" className="implementation-error">Report changed. Reload it before reviewing.</p>}
      <div className="implementation-review-actions"><button aria-label="Previous task" disabled={busy || position === 0} onClick={onPrevious}>‹</button><span>{position + 1} / {total}</span><button aria-label="Next task" disabled={busy || position === total - 1} onClick={onNext}>›</button><div className="grow" />
        {canToggle && <button disabled={taskBusy || busy} onClick={onToggle}>{task.completed ? 'Mark incomplete' : 'Mark completed'}</button>}
        {task.review && <button disabled={busy || loading} onClick={() => void load()}>Reload report</button>}
        {canReview && <><button disabled={busy} onClick={() => { setMode('rejected'); setComment(''); }}>Reject implementation</button><button disabled={busy} onClick={() => { setMode('needs_revision'); setComment(''); }}>Revise implementation</button><button className="primary" disabled={busy || report?.sourceChanged} onClick={() => void decide('approved')}>Approve & next</button></>}
      </div>
    </footer>
    {mode && <Dialog title={mode === 'needs_revision' ? 'Request implementation changes' : 'Reject implementation'} busy={busy} onClose={() => setMode(null)}><div className="dialog-body p-6"><p className="mb-3 text-sm">{taskTitle(task)}</p><label className="field">Implementation review comment<textarea data-autofocus value={comment} onChange={event => setComment(event.target.value)} rows={4} /></label>{error && <p role="alert" className="text-red-600 mt-3">{error}</p>}</div><div className="dialog-footer p-4 flex justify-end gap-2"><button disabled={busy} onClick={() => setMode(null)}>Cancel</button><button className="primary" disabled={busy || !comment.trim() || !canReview} onClick={() => void decide(mode)}>Confirm {mode === 'needs_revision' ? 'revision' : 'rejection'}</button></div></Dialog>}
  </section>;
}
