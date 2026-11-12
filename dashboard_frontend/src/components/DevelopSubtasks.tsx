import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { BulkImplementationReview } from './BulkImplementationReview';
import { ImplementationReview, reviewLabel } from './ImplementationReview';
import { Dialog } from './Dialog';
import { taskTitle } from '../lib/implementation-report';
import type { SpecFile } from '../types';

export function DevelopSubtasks({ repoId, spec, planContent }: { repoId: string; spec: SpecFile; planContent?: string }) {
  const develop = spec.stages[3];
  const tasks = develop.subtasks ?? [];
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'revision'>('all');
  const [query, setQuery] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = tasks.filter(task => task.review?.status === 'pending_review');
  const revised = tasks.filter(task => ['Needs revision', 'Rejected'].includes(reviewLabel(task)));
  const approved = tasks.filter(task => task.review?.status === 'approved');
  const visible = tasks.filter(task => (filter === 'all' || (filter === 'pending' ? pending : revised).includes(task)) && [task.id, task.title, task.description, task.requirementRef, ...task.files].some(value => value?.toLowerCase().includes(query.toLowerCase())));
  const selected = visible.find(task => task.id === selectedId) ?? visible.find(task => task.review?.status === 'pending_review') ?? visible[0];
  const position = selected ? visible.indexOf(selected) : -1;
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  const canManage = spec.currentStageId === 'develop' && !spec.automation?.enabled && spec.execution.status !== 'paused';
  return <section className="develop-workspace" aria-label="Development tasks">
    <header className="develop-workspace-header">
      <div><h2>Development tasks <span className="task-count">{tasks.length}</span></h2><p>{pending.length} pending review · {approved.length} approved · {tasks.filter(task => task.completed).length}/{tasks.length} implemented</p></div>
      <span className={'task-status ' + (develop.gate.status === 'approved' ? 'task-status-approved' : 'task-status-pending-review')}>Plan: {develop.gate.status.replaceAll('_', ' ')}</span>
      <div className="grow" />
      {planContent && <button onClick={() => setShowPlan(true)}>View development plan</button>}
      <BulkImplementationReview key={spec.ticketId} repoId={repoId} ticketId={spec.ticketId} tasks={tasks} canReview={spec.currentStageId === 'develop'} />
      {tasks.length > 0 && tasks.every(task => task.completed) && spec.currentStageId === 'develop' && spec.execution.status !== 'paused' && <button disabled={busy || reviewBusy || spec.automation?.status === 'running'} onClick={() => void run(() => api.submitImplementationReview(repoId, spec.ticketId))}>Submit implementation for review</button>}
    </header>
    {error && <p role="alert" className="implementation-error px-4">{error}</p>}
    <div className="develop-workspace-columns">
      <aside className="develop-task-list" aria-label="Subtasks">
        <div className="develop-list-tools"><div className="develop-filters" aria-label="Filter tasks">{(['all', 'pending', 'revision'] as const).map(value => <button key={value} disabled={reviewBusy} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : value === 'pending' ? 'Pending review' : 'Needs revision'} <span>{value === 'all' ? tasks.length : value === 'pending' ? pending.length : revised.length}</span></button>)}</div><input type="search" aria-label="Search development tasks" placeholder="Search task, AC or file" disabled={reviewBusy} value={query} onChange={event => setQuery(event.target.value)} /></div>
        <div className="develop-task-rows">{visible.map(task => <button key={task.id} className="develop-task-row" disabled={reviewBusy} aria-pressed={selected?.id === task.id} aria-label={'Select task ' + taskTitle(task)} onClick={() => setSelectedId(task.id)}>
          <span className="task-number">{String(tasks.indexOf(task) + 1).padStart(2, '0')}</span><span className="task-row-content"><span className="task-row-heading"><strong>{taskTitle(task)}</strong><span className={'task-status task-status-' + reviewLabel(task).toLowerCase().replaceAll(' ', '-')}>{reviewLabel(task)}</span></span><span className="task-row-meta">{task.requirementRef || 'No AC link'} · {task.files.length} declared files · {task.completed ? 'Implemented' : task.status === 'running' ? 'Running' : 'Pending'}</span></span>
        </button>)}{!visible.length && <p className="develop-no-results">{tasks.length ? 'No tasks match your filters.' : 'No development tasks yet.'}</p>}</div>
        {canManage && <details className="develop-manage"><summary>Manage tasks</summary><form onSubmit={event => { event.preventDefault(); if (!newDesc.trim() || busy || reviewBusy) return; void run(async () => { await api.setSubtasks(repoId, spec.ticketId, [...tasks.map(task => ({ id: task.id, title: task.title, description: task.description, prompt: task.prompt, requirementRef: task.requirementRef, testRefs: task.testRefs, dependsOn: task.dependsOn, files: task.files, leverage: task.leverage })), { description: newDesc.trim() }]); setNewDesc(''); }); }}><input aria-label="New subtask description" placeholder="Add a subtask..." value={newDesc} onChange={event => setNewDesc(event.target.value)} /><button disabled={busy || reviewBusy || !newDesc.trim()}>Add</button></form><p>Changing tasks requires a new plan approval.</p></details>}
      </aside>
      {selected ? <ImplementationReview key={selected.id + ':' + (selected.review?.id ?? 'draft')} repoId={repoId} ticketId={spec.ticketId} task={selected} spec={spec} position={position} total={visible.length} onPrevious={() => setSelectedId(visible[position - 1].id)} onNext={() => setSelectedId(visible[position + 1].id)} onBusy={setReviewBusy} taskBusy={busy} onToggle={() => void run(() => api.completeTask(repoId, spec.ticketId, selected.id, !selected.completed, selected.claimId))} onApproved={updated => {
        const updatedTasks = updated.stages[3].subtasks ?? [];
        const next = [...updatedTasks.slice(updatedTasks.findIndex(task => task.id === selected.id) + 1), ...updatedTasks].find(task => task.review?.status === 'pending_review');
        if (next) setSelectedId(next.id);
      }} /> : <div className="implementation-empty"><h3>Select a task to review</h3><p>Task requirements, implementation reports and review history appear here.</p></div>}
    </div>
    {showPlan && <Dialog title="Development plan" onClose={() => setShowPlan(false)}><div className="dialog-body p-6 md-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{planContent}</ReactMarkdown></div></Dialog>}
  </section>;
}
