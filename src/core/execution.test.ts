import { it, expect } from 'vitest';
import { StageMachine } from './stage-machine.js';
import { nextActions } from './execution.js';
import type { SpecFile } from './schemas.js';
import { filesConflict } from './task-scheduler.js';

const machine = new StageMachine();
function implementation(): SpecFile {
  let spec = machine.createSpec({ ticketId: 'RUN-1', title: 'Run', workflowKind: 'bugfix' });
  spec = machine.advance(machine.approve(machine.recordAiOutput(spec, 'spec', { kind: 'markdown', path: 'spec.md' }), 'spec'), 'spec');
  return spec;
}
function planned() {
  let spec = machine.setSubtasks(implementation(), [
    { id: 'A', description: 'API', files: ['src/api.ts'] },
    { id: 'B', description: 'UI', files: ['src/ui.ts'] },
    { id: 'C', description: 'Integration', dependsOn: ['A'], files: ['src/api.ts'] },
  ]);
  spec = machine.recordAiOutput(spec, 'develop', { kind: 'markdown', path: 'plan.md' });
  return machine.approve(spec, 'develop');
}
it('rejects cyclic and unknown dependencies before accepting a plan', () => {
  expect(() => machine.setSubtasks(implementation(), [{ id: 'A', description: 'A', dependsOn: ['B'] }, { id: 'B', description: 'B', dependsOn: ['A'] }])).toThrow(/cycle/i);
  expect(() => machine.setSubtasks(implementation(), [{ id: 'A', description: 'A', dependsOn: ['missing'] }])).toThrow(/unknown dependency/i);
});
it('allows independent claims but blocks dependent and conflicting work', () => {
  let spec = machine.claimSubtask(planned(), 'A');
  spec = machine.claimSubtask(spec, 'B');
  expect(spec.stages[3].subtasks!.filter((task) => task.status === 'running')).toHaveLength(2);
  expect(() => machine.claimSubtask(spec, 'C')).toThrow(/dependency/i);
  const conflict = planned();
  conflict.stages[3].subtasks![1].files = ['src/api.ts'];
  expect(() => machine.claimSubtask(machine.claimSubtask(conflict, 'A'), 'B')).toThrow(/conflict/i);
});
it('development plan approval prompts implementation rather than advancement', () => {
  expect(nextActions(planned()).map((action) => action.tool)).toContain('claim_subtask');
  expect(nextActions(planned()).map((action) => action.tool)).not.toContain('advance_stage');
});
it('final approval produces a completed state without another advance', () => {
  const spec = planned(); spec.currentStageId = 'ops';
  const ops = spec.stages[7]; ops.revision = 1; ops.gate = { status: 'approved', approvedRevision: 1 };
  expect(nextActions(spec)).toEqual([]);
});
it('paused execution has no executable next action', () => {
  const spec = planned(); spec.execution.status = 'paused';
  expect(nextActions(spec)).toEqual([]);
});
it('directory declarations conflict with files inside the directory', () => {
  const tasks = planned().stages[3].subtasks!;
  tasks[0].files = ['src/']; tasks[1].files = ['src/ui.ts'];
  expect(filesConflict(tasks[0], tasks[1])).toBe(true);
});
it('resetting upstream completion retains running dependent claims until release', () => {
  let spec = machine.setSubtaskCompleted(planned(), 'A', true);
  spec = machine.claimSubtask(spec, 'C');
  const claim = spec.stages[3].subtasks![2].claimId;
  expect(() => machine.setSubtaskCompleted(spec, 'A', false)).toThrow(/running|release/i);
  expect(spec.stages[3].subtasks![2].claimId).toBe(claim);
  spec = machine.releaseSubtask(spec, 'C', claim!);
  expect(machine.setSubtaskCompleted(spec, 'A', false).stages[3].subtasks![0].completed).toBe(false);
});
