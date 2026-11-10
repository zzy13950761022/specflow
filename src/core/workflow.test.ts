import { describe, it, expect } from 'vitest';
import { StageMachine } from './stage-machine.js';
import type { SpecFile } from './schemas.js';
import { assertEvidence } from './check-runner.js';

const machine = new StageMachine();
function readySpec() { return machine.recordAiOutput(machine.createSpec({ ticketId: 'FLOW-2', title: 'Guard' }), 'spec', { kind: 'markdown', path: 'spec.md' }); }
function atTest(): SpecFile {
  const spec = machine.createSpec({ ticketId: 'FLOW-1', title: 'Workflow' });
  spec.currentStageId = 'test';
  for (const stage of spec.stages.slice(0, 5)) {
    stage.artifact = { kind: 'markdown', path: `${stage.id}.md` };
    stage.aiStatus = 'done';
    stage.gate.status = 'approved';
    stage.revision = 1;
    stage.gate.approvedRevision = 1;
  }
  spec.stages[4].gate.status = 'pending_review';
  return spec;
}

describe('P1 cross-stage rework', () => {
  it('reopens design, invalidates downstream and preserves artifacts', () => {
    const spec = atTest();
    const next = machine.reopen(spec, 'design', 'Interface contract is incorrect');
    expect(next.stages[2].gate.status).toBe('needs_revision');
    expect(next.stages[2].aiStatus).toBe('in_progress');
    expect(next.stages[3].gate.status).toBe('not_ready');
    expect(next.stages[4].stale).toBe(true);
    expect(next.stages[4].artifact).toEqual(spec.stages[4].artifact);
    expect(next.reworkHistory).toHaveLength(1);
    expect(spec.stages[2].gate.status).toBe('approved');
  });

  it('rejects empty reasons and unopened targets', () => {
    expect(() => machine.reopen(atTest(), 'design', '  ')).toThrow(/reason/i);
    expect(() => machine.reopen(atTest(), 'ops', 'Investigate')).toThrow(/not.*started|not.*reached/i);
  });

  it('requires a new submission to clear target staleness', () => {
    const reopened = machine.reopen(atTest(), 'design', 'Fix contract');
    const next = machine.recordAiOutput(reopened, 'design', { kind: 'markdown', path: 'design-v2.md' });
    expect(next.stages[2].stale).toBe(false);
    expect(next.stages[4].stale).toBe(true);
  });
});

describe('P3 authoritative verification gates', () => {
  it('AI metrics cannot approve a test artifact', () => {
    const spec = atTest();
    spec.stages[4].artifact = { kind: 'markdown', path: 'test.md', metrics: { stageCoverage: 1, buildSuccess: true } };
    expect(() => machine.approve(spec, 'test')).toThrow(/platform.*check/i);
  });
  it('rejects evidence for a different source revision', () => {
    const evidence = { runId: 'r', stageId: 'build' as const, command: 'node', args: [], exitCode: 0, startedAt: 'now', finishedAt: 'now', codeFingerprint: 'old', codeChanged: false, timedOut: false, outputTruncated: false, outputPath: 'out.log' };
    expect(() => assertEvidence(evidence, 'build', 'new')).toThrow(/code changed/i);
  });
});

describe('P2 transition constraints', () => {
  it('rejects out-of-order submissions and unready approvals', () => {
    const spec = machine.createSpec({ ticketId: 'G-1', title: 'Guard' });
    expect(() => machine.recordAiOutput(spec, 'design', { kind: 'markdown', path: 'x' })).toThrow(/current stage/i);
    expect(() => machine.approve(spec, 'spec')).toThrow(/pending.review/i);
  });
  it('binds approval to the submitted revision', () => {
    const spec = readySpec();
    expect(() => machine.approve(spec, 'spec', 0)).toThrow(/revision/i);
    expect(machine.approve(spec, 'spec', 1).stages[0].gate.approvedRevision).toBe(1);
  });
  it('cannot silently overwrite a pending or approved artifact', () => {
    const spec = readySpec();
    expect(() => machine.recordAiOutput(spec, 'spec', { kind: 'markdown', path: 'new' })).toThrow(/review|reopen/i);
    expect(() => machine.recordAiOutput(machine.approve(spec, 'spec'), 'spec', { kind: 'markdown', path: 'new' })).toThrow(/reopen/i);
  });
  it('advance is idempotent and preserves the next artifact', () => {
    const spec = machine.advance(machine.approve(readySpec(), 'spec'), 'spec');
    const next = machine.recordAiOutput(spec, 'requirements', { kind: 'markdown', path: 'req.md' });
    expect(machine.advance(next, 'spec')).toEqual(next);
  });
  it('cannot use stale approval to advance', () => {
    const spec = machine.approve(readySpec(), 'spec');
    spec.stages[0].revision++;
    expect(() => machine.advance(spec, 'spec')).toThrow(/revision/i);
  });
});
