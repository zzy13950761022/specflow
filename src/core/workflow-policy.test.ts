import { it, expect } from 'vitest';
import { StageMachine } from './stage-machine.js';
import { canAutoApprove } from './workflow-policy.js';

it('bugfix advances from SPEC to DEVELOP with explicit skip reasons', () => {
  const machine = new StageMachine();
  let spec = machine.createSpec({ ticketId: 'BUG-1', title: 'Fix', workflowKind: 'bugfix' });
  spec = machine.recordAiOutput(spec, 'spec', { kind: 'markdown', path: 'spec.md' });
  spec = machine.advance(machine.approve(spec, 'spec'), 'spec');
  expect(spec.currentStageId).toBe('develop');
  expect(spec.stages[1].skipped).toBe(true);
  expect(spec.stages[1].skipReason).toContain('bugfix');
  expect(spec.stages[1].gate.status).not.toBe('approved');
});
it('documentation has only SPEC, DEVELOP and OPS', () => {
  const spec = new StageMachine().createSpec({ ticketId: 'DOC-1', title: 'Docs', workflowKind: 'documentation' });
  expect(spec.stages.filter((stage) => !stage.skipped).map((stage) => stage.id)).toEqual(['spec', 'develop', 'ops']);
});
it('automatic checks require explicit low-risk opt-in and never approve release decisions', () => {
  const spec = new StageMachine().createSpec({ ticketId: 'AUTO-1', title: 'Policy', risk: 'low', autoChecks: true });
  expect(canAutoApprove(spec, 'test')).toBe(true);
  expect(canAutoApprove(spec, 'deploy')).toBe(false);
  spec.workflow.risk = 'high';
  expect(canAutoApprove(spec, 'test')).toBe(false);
});
