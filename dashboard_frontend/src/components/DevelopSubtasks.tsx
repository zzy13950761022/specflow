import { useState } from 'react';
import { api } from '../api';
import type { SpecFile } from '../types';

export function DevelopSubtasks({ repoId, spec }: { repoId: string; spec: SpecFile }) {
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
        ...subtasks.map((t) => ({
          description: t.description,
          prompt: t.prompt,
          requirementRef: t.requirementRef,
        })),
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
            style={{
              width: subtasks.length
                ? `${Math.round((doneCount / subtasks.length) * 100)}%`
                : '0%',
            }}
          />
        </div>
      )}

      <div className="flex gap-1.5 mt-0.5">
        <input
          value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
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
