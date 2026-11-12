import { posix } from 'path';
import type { Subtask } from './schemas.js';

export function normalizedFile(path: string): string {
  let normalized = posix.normalize(path.replaceAll(String.fromCharCode(92), '/'));
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (!normalized || normalized === '.') throw new Error('Declare specific repository files or directories.');
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes(':')) throw new Error('Task files must be repository-relative paths.');
  return normalized;
}

export function validateTasks(tasks: Subtask[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error('Task IDs must be unique.');
  const visited = new Set<string>(); const visiting = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error('Task dependency cycle detected.');
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error('Unknown dependency: ' + id);
    visiting.add(id);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id);
  }
  for (const task of tasks) { task.files.forEach(normalizedFile); visit(task.id); }
}

export function filesConflict(a: Subtask, b: Subtask): boolean {
  if (!a.files.length || !b.files.length) return true;
  return a.files.some((left) => b.files.some((right) => {
    const l = normalizedFile(left).toLowerCase(); const r = normalizedFile(right).toLowerCase();
    return l === r || l.startsWith(r + '/') || r.startsWith(l + '/');
  }));
}

export function readyTasks(tasks: Subtask[]): Subtask[] {
  return tasks.filter((task) => !task.completed && task.status !== 'running' && task.dependsOn.every((id) => tasks.some((dependency) => dependency.id === id && dependency.completed)) && !tasks.some((other) => other.status === 'running' && filesConflict(task, other)));
}

export function resetTaskAndDependents(tasks: Subtask[], id: string): void {
  resetTasksAndDependents(tasks, [id]);
}

export function resetTasksAndDependents(tasks: Subtask[], ids: string[]): void {
  const roots = new Set(ids);
  const affected = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) if (!affected.has(task.id) && task.dependsOn.some((id) => affected.has(id))) { affected.add(task.id); changed = true; }
  }
  if (tasks.some((task) => !roots.has(task.id) && affected.has(task.id) && task.status === 'running')) throw new Error('Release running dependent tasks before resetting upstream work.');
  for (const task of tasks) if (affected.has(task.id)) { task.completed = false; task.status = 'pending'; task.claimId = undefined; task.attempt++; }
}
