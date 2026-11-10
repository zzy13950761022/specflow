import { it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StageMachine } from './stage-machine.js';
import { SpecStore } from './spec-store.js';
import { restoreLegacyCompletion } from './legacy-completion.js';

function legacy() {
  const spec = new StageMachine().createSpec({ ticketId: 'OLD-1', title: 'Completed feature' });
  spec.schemaVersion = 2;
  spec.gateHistory = [];
  for (const stage of spec.stages) {
    stage.aiStatus = 'done';
    stage.artifact = { kind: 'markdown', path: stage.id + '.md' };
    stage.gate = { status: 'approved', reviewedAt: '2026-10-20T02:00:00.000Z' };
    stage.artifactHistory = [{ path: stage.id + '-history.md', at: '2026-10-20T01:00:00.000Z' }];
    spec.gateHistory.push({ stageId: stage.id, from: 'pending_review', to: 'approved', at: stage.gate.reviewedAt! });
  }
  spec.stages[3].subtasks = [{ id: 'A', description: 'Implemented', completed: true, status: 'pending', attempt: 0, dependsOn: [], files: [], testRefs: [] }];
  return spec;
}

it('reads completed v2 tickets as completed without invalidating their approvals or work', async () => {
  const repo = await fs.mkdtemp(join(tmpdir(), 'legacy-completion-'));
  try {
    await fs.mkdir(join(repo, '.specflow/specs'), { recursive: true });
    const original = legacy();
    const target = join(repo, '.specflow/specs/OLD-1.json');
    await fs.writeFile(target, JSON.stringify(original));
    const read = (await new SpecStore().read(repo, 'OLD-1'))!;
    expect(read).toMatchObject({ schemaVersion: 3, currentStageId: 'ops', execution: { status: 'completed' }, legacyCompletion: { sourceSchemaVersion: 2 } });
    expect(read.stages.every((stage) => stage.gate.status === 'approved')).toBe(true);
    expect(read.stages[3].subtasks![0]).toMatchObject({ completed: true, status: 'done', attempt: 0 });
    expect(read.gateHistory).toEqual(original.gateHistory);
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual(original);
  } finally { await fs.rm(repo, { recursive: true, force: true }); }
});

it('keeps incomplete legacy workflows subject to conservative migration', async () => {
  const repo = await fs.mkdtemp(join(tmpdir(), 'legacy-incomplete-'));
  try {
    const spec = legacy(); spec.stages[7].gate.status = 'pending_review';
    await fs.mkdir(join(repo, '.specflow/specs'), { recursive: true });
    await fs.writeFile(join(repo, '.specflow/specs/OLD-1.json'), JSON.stringify(spec));
    const read = (await new SpecStore().read(repo, 'OLD-1'))!;
    expect(read.currentStageId).toBe('spec');
    expect(read.stages[3].subtasks![0].completed).toBe(false);
    expect(read.stages[0].gate.status).toBe('pending_review');
  } finally { await fs.rm(repo, { recursive: true, force: true }); }
});

it('restores the old migration reset using historical approvals, retaining all history', () => {
  const spec = legacy(); spec.schemaVersion = 3;
  for (const stage of spec.stages) { stage.revision = 1; stage.gate.status = 'pending_review'; }
  spec.stages[3].subtasks![0] = { ...spec.stages[3].subtasks![0], completed: false, status: 'pending', attempt: 1 };
  spec.stages[0].gate = { status: 'approved', approvedRevision: 1, reviewedAt: '2026-11-10T02:25:00.000Z', actor: 'human' };
  spec.gateHistory.push({ stageId: 'spec', from: 'pending_review', to: 'approved', revision: 1, actor: 'human', at: spec.stages[0].gate.reviewedAt! });
  const restored = restoreLegacyCompletion(spec);
  expect(restored.currentStageId).toBe('ops');
  expect(restored.execution.status).toBe('completed');
  expect(restored.stages[3].subtasks![0]).toMatchObject({ completed: true, status: 'done', attempt: 1 });
  expect(restored.gateHistory).toEqual(spec.gateHistory);
  expect(restored.stages[1].gate.reviewedAt).toBe('2026-10-20T02:00:00.000Z');
  expect(restored.stages[4].evidence).toBeUndefined();
  expect(restoreLegacyCompletion(restored)).toEqual(restored);
  const reopened = new StageMachine().reopen(restored, 'design', 'New requirement');
  expect(reopened.stages[3].subtasks![0].completed).toBe(false);
  expect(reopened.stages[2].gate.status).toBe('needs_revision');
});

it('refuses to restore tickets with rework, newer outputs, running claims or incomplete historical approvals', () => {
  const rework = legacy(); rework.reworkHistory.push({ stageId: 'design', at: '2026-11-10T02:00:00.000Z', reason: 'Changed' });
  const newer = legacy(); newer.stages[0].artifactHistory!.push({ path: 'new.md', at: '2026-11-10T02:00:00.000Z', revision: 2 });
  const claimed = legacy(); claimed.stages[3].subtasks![0].status = 'running';
  const incomplete = legacy(); incomplete.gateHistory.pop();
  for (const spec of [rework, newer, claimed, incomplete]) expect(() => restoreLegacyCompletion(spec)).toThrow(/completed legacy/i);
});
