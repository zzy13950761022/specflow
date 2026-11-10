import { it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildStageContext, traceability, validLogs } from './stage-context.js';
import { SubtaskSchema, ImplementationLogSchema } from './schemas.js';
import { StageMachine } from './stage-machine.js';

it('provides approved spec, design and current implementation context for TEST', async () => {
  const repo = await fs.mkdtemp(join(tmpdir(), 'context-'));
  try {
    const spec = new StageMachine().createSpec({ ticketId: 'CTX-1', title: 'Context' });
    for (const stage of spec.stages.slice(0, 4)) {
      stage.revision = 1; stage.gate = { status: 'approved', approvedRevision: 1 }; stage.aiStatus = 'done';
      stage.artifact = { kind: 'markdown', path: stage.id + '.md' };
      await fs.writeFile(join(repo, stage.artifact.path), stage.id.toUpperCase());
    }
    const context = await buildStageContext(repo, spec, 'test', []);
    expect(context.artifacts.map((item) => item.stageId)).toEqual(['spec', 'requirements', 'design', 'develop']);
    expect(context.artifacts[2].content).toBe('DESIGN');
    spec.stages[2].stale = true;
    await expect(buildStageContext(repo, spec, 'test', [])).rejects.toThrow(/design.*valid|design.*stale/i);
  } finally { await fs.rm(repo, { recursive: true, force: true }); }
});

it('does not resurrect implementation logs from earlier task attempts', () => {
  const spec = new StageMachine().createSpec({ ticketId: 'CTX-3', title: 'Retry' });
  spec.stages[3].revision = 2;
  spec.stages[3].subtasks = [SubtaskSchema.parse({ id: 'A', description: 'A', completed: true, attempt: 1 })];
  const log = ImplementationLogSchema.parse({ id: 'old', ticketId: 'CTX-3', subtaskId: 'A', summary: 'Old attempt', filesModified: ['old.ts'], filesCreated: [], statistics: { linesAdded: 1, linesRemoved: 0 }, artifacts: {}, createdAt: 'now', developRevision: 2, taskAttempt: 0 });
  expect(validLogs(spec, [log])).toEqual([]);
});

it('reports unimplemented acceptance criteria and absent test references', () => {
  const spec = new StageMachine().createSpec({ ticketId: 'CTX-2', title: 'Trace' });
  spec.acceptanceCriteria = [{ id: 'AC-1', given: 'Cart', when: 'Coupon', then: 'Discount' }, { id: 'AC-2', given: 'Cart', when: 'Invalid coupon', then: 'Error' }];
  spec.stages[3].subtasks = [{ id: 'T-1', description: 'Coupon', completed: false, requirementRef: 'AC-1', testRefs: [] }];
  const report = traceability(spec, []);
  expect(report.unimplementedCriteria).toEqual(['AC-2']);
  expect(report.untestedCriteria).toEqual(['AC-1', 'AC-2']);
});
