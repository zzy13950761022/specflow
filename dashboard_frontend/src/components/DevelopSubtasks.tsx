import { useState } from 'react';
import { api } from '../api';
import { BulkImplementationReview } from './BulkImplementationReview';
import { ImplementationReview } from './ImplementationReview';
import type { SpecFile } from '../types';

export function DevelopSubtasks({ repoId, spec }: { repoId: string; spec: SpecFile }) {
  const develop = spec.stages.find((s) => s.id === 'develop')!;
  const subtasks = develop.subtasks ?? [];
  const [newDesc, setNewDesc] = useState('');
  const [adding, setAdding] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doneCount = subtasks.filter((t) => t.completed).length;

  async function handleToggle(subtaskId: string) {
    setToggling(subtaskId);
    setError(null);
    try {
      const task = subtasks.find((task) => task.id === subtaskId)!;
      await api.completeTask(repoId, spec.ticketId, subtaskId, !task.completed, task.claimId);
    } catch (error) {
      setError(String((error as Error).message));
    } finally {
      setToggling(null);
    }
  }

  async function handleAdd() {
    const desc = newDesc.trim();
    if (!desc) return;
    setAdding(true);
    setError(null);
    try {
      await api.setSubtasks(repoId, spec.ticketId, [
        ...subtasks.map((t) => ({
          id: t.id,
          description: t.description,
          prompt: t.prompt,
          requirementRef: t.requirementRef,
          testRefs: t.testRefs,
          dependsOn: t.dependsOn,
          files: t.files,
          leverage: t.leverage,
        })),
        { description: desc },
      ]);
      setNewDesc('');
    } catch (error) {
      setError(String((error as Error).message));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-blue-100 pt-2 mt-0.5">
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center justify-between text-[11px] text-slate-500">
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
              className={`flex items-start gap-2 text-[11px] cursor-pointer rounded-lg px-2 py-1 hover:bg-blue-50 transition ${
                task.completed ? 'text-slate-500 line-through' : 'text-gray-800'
              }`}
            >
              <input
                type="checkbox"
                checked={task.completed}
                disabled={toggling === task.id || develop.gate.status !== 'approved' || spec.execution.status === 'paused' || !!spec.automation?.enabled || !!task.review}
                onChange={() => handleToggle(task.id)}
                className="mt-0.5 shrink-0 accent-joule-purple"
              />
              <span className="break-words min-w-0">{task.description}</span>
              <span className="text-slate-500">{task.status} {task.dependsOn.length ? '· depends on ' + task.dependsOn.join(', ') : ''}</span>
            </label>
          ))}
        </div>
      )}

      {subtasks.length > 0 && (
        <div className="h-1 rounded-full bg-gray-200 overflow-hidden">
          <div
            className="h-full joule-gradient transition-all"
            style={{
              width: subtasks.length
                ? `${Math.round((doneCount / subtasks.length) * 100)}%`
                : '0%',
            }}
          />
        </div>
      )}
      {subtasks.length > 0 && subtasks.every((task) => task.completed) && spec.currentStageId === 'develop' && spec.execution.status !== 'paused' && (
        <button disabled={spec.automation?.status === 'running'} className="rounded-lg bg-blue-100 px-3 py-2 text-sm disabled:opacity-50" onClick={async () => { try { await api.submitImplementationReview(repoId, spec.ticketId); } catch (error) { setError(String((error as Error).message)); } }}>Submit implementation for review</button>
      )}
      <BulkImplementationReview key={spec.ticketId} repoId={repoId} ticketId={spec.ticketId} tasks={subtasks} canReview={spec.currentStageId === 'develop'} />
      {subtasks.filter((task) => task.review).map((task) => <ImplementationReview key={task.review!.id} repoId={repoId} ticketId={spec.ticketId} task={task} onDone={() => {}} />)}

      <div className="flex gap-1.5 mt-0.5">
        <input
          value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
          placeholder="Add a subtask..."
          className="flex-1 bg-gray-100 rounded-lg px-2 py-1 text-[11px] outline-none border border-blue-200 focus:border-blue-500"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newDesc.trim() || !!spec.automation?.enabled || spec.execution.status === 'paused'}
          className="rounded-lg bg-white/10 hover:bg-white/15 text-[11px] px-2 py-1 disabled:opacity-50"
        >
          +
        </button>
      </div>
    </div>
  );
}
