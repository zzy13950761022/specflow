import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { StageMachine } from '../core/stage-machine.js';
import { STAGE_IDS, type SpecFile, type StageId } from '../core/schemas.js';
import type { AppCore } from '../core/app-core.js';

/** Domain snapshot with valid upstream approvals, for isolated stage tests. */
export function atStage(spec: SpecFile, stageId: StageId): SpecFile {
  const next = structuredClone(spec); next.currentStageId = stageId;
  for (const stage of next.stages.slice(0, STAGE_IDS.indexOf(stageId))) {
    if (stage.skipped) continue;
    stage.revision = 1; stage.aiStatus = 'done';
    stage.gate = { status: 'approved', approvedRevision: 1, actor: 'human' };
    stage.artifact = { kind: 'markdown', path: '.specflow/fixtures/' + stage.id + '.md' };
  }
  return next;
}

export async function prepareStage(app: AppCore, repo: string, repoId: string, ticketId: string, stageId: StageId) {
  const spec = atStage((await app.getSpec(repoId, ticketId))!, stageId);
  for (const stage of spec.stages.slice(0, STAGE_IDS.indexOf(stageId))) if (stage.artifact) {
    const path = join(repo, stage.artifact.path); await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, 'Approved ' + stage.id);
  }
  await app.store.write(repo, spec);
}

export function approvePlan(spec: SpecFile): SpecFile {
  const machine = new StageMachine();
  return machine.approve(machine.recordAiOutput(spec, 'develop', { kind: 'markdown', path: 'plan.md' }), 'develop');
}

export async function prepareImplementation(app: AppCore, repoId: string, ticketId: string) {
  await app.recordAiOutput(repoId, ticketId, 'develop', 'Implementation plan');
  await app.approve(repoId, ticketId, 'develop');
}

export async function recordTaskLog(app: AppCore, repoId: string, ticketId: string, subtaskId: string) {
  await app.logImplementation(repoId, ticketId, subtaskId, { summary: 'Fixture implementation', filesModified: ['src/example.ts'], filesCreated: [], statistics: { linesAdded: 1, linesRemoved: 0 }, artifacts: {} });
}
