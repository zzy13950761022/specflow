import { promises as fs } from 'fs';
import { join } from 'path';
import { STAGE_IDS, type SpecFile, type StageId, type ImplementationLog } from './schemas.js';

export async function buildStageContext(repo: string, spec: SpecFile, stageId: StageId, logs: ImplementationLog[]) {
  const artifacts: Array<{ stageId: StageId; revision: number; path: string; content: string }> = [];
  for (const stage of spec.stages.slice(0, STAGE_IDS.indexOf(stageId))) {
    if (stage.skipped) continue;
    if (stage.stale || stage.gate.status !== 'approved' || stage.gate.approvedRevision !== stage.revision || !stage.artifact) {
      throw new Error('Upstream ' + stage.id + ' lacks valid approval or is stale. Complete it before continuing.');
    }
    const snapshot = stage.artifactHistory?.slice().reverse().find((entry) => entry.revision === stage.revision);
    let content: string;
    try { content = await fs.readFile(join(repo, snapshot?.path ?? stage.artifact.path), 'utf8'); }
    catch { throw new Error('Required upstream artifact is missing: ' + stage.artifact.path); }
    artifacts.push({ stageId: stage.id, revision: stage.revision, path: stage.artifact.path, content });
  }
  return { stageId, acceptanceCriteria: spec.acceptanceCriteria, artifacts, implementationLogs: STAGE_IDS.indexOf(stageId) >= 4 ? validLogs(spec, logs) : [] };
}

export function validLogs(spec: SpecFile, logs: ImplementationLog[]): ImplementationLog[] {
  const develop = spec.stages.find((stage) => stage.id === 'develop')!;
  if (develop.stale) return [];
  return logs.filter((log) => log.developRevision === develop.revision && develop.subtasks?.some((task) => task.id === log.subtaskId && task.completed && log.taskAttempt === task.attempt));
}

export function traceability(spec: SpecFile, logs: ImplementationLog[]) {
  const tasks = spec.stages.find((stage) => stage.id === 'develop')?.subtasks ?? [];
  const currentLogs = validLogs(spec, logs);
  const rows = spec.acceptanceCriteria.map((criterion) => {
    const matches = tasks.filter((task) => task.requirementRef === criterion.id);
    return { criterion, tasks: matches.map((task) => ({
      id: task.id, description: task.description, completed: task.completed,
      files: [...new Set(currentLogs.filter((log) => log.subtaskId === task.id).flatMap((log) => [...log.filesModified, ...log.filesCreated]))],
      testRefs: task.testRefs,
    })) };
  });
  return {
    rows,
    unimplementedCriteria: rows.filter((row) => row.tasks.length === 0).map((row) => row.criterion.id),
    untestedCriteria: rows.filter((row) => row.tasks.every((task) => task.testRefs.length === 0)).map((row) => row.criterion.id),
    unknownReferences: tasks.filter((task) => task.requirementRef && !spec.acceptanceCriteria.some((criterion) => criterion.id === task.requirementRef)).map((task) => task.id),
    unlinkedTasks: tasks.filter((task) => !task.requirementRef).map((task) => task.id),
  };
}
