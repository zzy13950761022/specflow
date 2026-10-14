import { describe, it, expect } from 'vitest';
import { StageMachine, GateNotApprovedError } from './stage-machine.js';
import { STAGE_IDS } from './schemas.js';

describe('StageMachine.createSpec', () => {
  it('creates all 8 stages in fixed order', () => {
    const sm = new StageMachine();
    const spec = sm.createSpec({ ticketId: 'ABC-1', title: 'Hello World' });
    expect(spec.stages.map((s) => s.id)).toEqual([...STAGE_IDS]);
  });

  it('derives specPath as specs/{TICKET}-{slug}.md', () => {
    const sm = new StageMachine();
    const spec = sm.createSpec({ ticketId: 'ABC-123', title: 'Checkout Tax!' });
    expect(spec.specPath).toBe('specs/ABC-123-checkout-tax.md');
  });

  it('marks stages 0 & 1 auto and 2-7 stubbed', () => {
    const sm = new StageMachine();
    const spec = sm.createSpec({ ticketId: 'ABC-1', title: 'x' });
    expect(spec.stages[0].aiCapability).toBe('auto'); // spec
    expect(spec.stages[1].aiCapability).toBe('auto'); // requirements
    for (let i = 2; i < 8; i++) {
      expect(spec.stages[i].aiCapability).toBe('stub');
      expect(spec.stages[i].aiStatus).toBe('stubbed');
    }
  });

  it('opens the first stage ready for AI, rest not_ready', () => {
    const sm = new StageMachine();
    const spec = sm.createSpec({ ticketId: 'ABC-1', title: 'x' });
    expect(spec.stages[0].aiStatus).toBe('not_started');
    expect(spec.stages[0].gate.status).toBe('not_ready');
  });

  it('gives the develop stage an empty subtasks placeholder', () => {
    const sm = new StageMachine();
    const spec = sm.createSpec({ ticketId: 'ABC-1', title: 'x' });
    const develop = spec.stages.find((s) => s.id === 'develop')!;
    expect(develop.subtasks).toEqual([]);
  });
});

describe('StageMachine.recordAiOutput', () => {
  it('marks aiStatus done and flips gate to pending_review', () => {
    const sm = new StageMachine();
    let spec = sm.createSpec({ ticketId: 'ABC-1', title: 'x' });
    spec = sm.recordAiOutput(spec, 'spec', '.specflow/.../0-spec.md');
    const stage = spec.stages[0];
    expect(stage.aiStatus).toBe('done');
    expect(stage.gate.status).toBe('pending_review');
    expect(stage.artifactPath).toBe('.specflow/.../0-spec.md');
  });
});

describe('StageMachine gate: approve / reject', () => {
  it('approve sets gate.status approved', () => {
    const sm = new StageMachine();
    let spec = sm.createSpec({ ticketId: 'ABC-1', title: 'x' });
    spec = sm.recordAiOutput(spec, 'spec', 'p');
    spec = sm.approve(spec, 'spec');
    expect(spec.stages[0].gate.status).toBe('approved');
  });

  it('reject routes back to in_progress and records the comment', () => {
    const sm = new StageMachine();
    let spec = sm.createSpec({ ticketId: 'ABC-1', title: 'x' });
    spec = sm.recordAiOutput(spec, 'spec', 'p');
    spec = sm.reject(spec, 'spec', 'needs more detail');
    expect(spec.stages[0].gate.status).toBe('rejected');
    expect(spec.stages[0].gate.comment).toBe('needs more detail');
    expect(spec.stages[0].aiStatus).toBe('in_progress');
  });

  it('records every gate transition in gateHistory', () => {
    const sm = new StageMachine();
    let spec = sm.createSpec({ ticketId: 'ABC-1', title: 'x' });
    spec = sm.recordAiOutput(spec, 'spec', 'p');
    spec = sm.reject(spec, 'spec', 'no');
    spec = sm.recordAiOutput(spec, 'spec', 'p');
    spec = sm.approve(spec, 'spec');
    const specGate = spec.gateHistory.filter((h) => h.stageId === 'spec');
    expect(specGate.map((h) => h.to)).toContain('approved');
    expect(specGate.map((h) => h.to)).toContain('rejected');
  });
});

describe('StageMachine.advance — the core gating invariant', () => {
  it('REFUSES to advance when the current gate is not approved', () => {
    const sm = new StageMachine();
    let spec = sm.createSpec({ ticketId: 'ABC-1', title: 'x' });
    spec = sm.recordAiOutput(spec, 'spec', 'p'); // gate = pending_review
    expect(() => sm.advance(spec, 'spec')).toThrow(GateNotApprovedError);
  });

  it('REFUSES to advance from a stage whose gate was never readied', () => {
    const sm = new StageMachine();
    const spec = sm.createSpec({ ticketId: 'ABC-1', title: 'x' });
    expect(() => sm.advance(spec, 'spec')).toThrow(GateNotApprovedError);
  });

  it('advances to the next stage once the gate is approved', () => {
    const sm = new StageMachine();
    let spec = sm.createSpec({ ticketId: 'ABC-1', title: 'x' });
    spec = sm.recordAiOutput(spec, 'spec', 'p');
    spec = sm.approve(spec, 'spec');
    spec = sm.advance(spec, 'spec');
    // requirements stage is now open for its AI action
    expect(spec.stages[1].aiStatus).toBe('not_started');
    expect(spec.stages[1].gate.status).toBe('not_ready');
  });

  it('full gating truth table: only approved allows advance', () => {
    const sm = new StageMachine();
    const base = sm.createSpec({ ticketId: 'ABC-1', title: 'x' });

    const cases: Array<{ gate: string; mutate: (s: typeof base) => typeof base; ok: boolean }> = [
      { gate: 'not_ready', mutate: (s) => s, ok: false },
      { gate: 'pending_review', mutate: (s) => sm.recordAiOutput(s, 'spec', 'p'), ok: false },
      { gate: 'rejected', mutate: (s) => sm.reject(sm.recordAiOutput(s, 'spec', 'p'), 'spec', 'no'), ok: false },
      { gate: 'approved', mutate: (s) => sm.approve(sm.recordAiOutput(s, 'spec', 'p'), 'spec'), ok: true },
    ];

    for (const c of cases) {
      const spec = c.mutate(structuredClone(base));
      if (c.ok) {
        expect(() => sm.advance(spec, 'spec'), c.gate).not.toThrow();
      } else {
        expect(() => sm.advance(spec, 'spec'), c.gate).toThrow(GateNotApprovedError);
      }
    }
  });

  it('cannot advance past the final stage (ops)', () => {
    const sm = new StageMachine();
    let spec = sm.createSpec({ ticketId: 'ABC-1', title: 'x' });
    // force ops gate approved directly for the test
    const ops = spec.stages[7];
    ops.gate.status = 'approved';
    expect(() => sm.advance(spec, 'ops')).toThrow(/final stage/i);
  });
});
