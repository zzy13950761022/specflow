import { describe, it, expect } from 'vitest';
import { StageMachine, GateNotApprovedError } from './stage-machine.js';
import { STAGE_IDS, GateStatusSchema } from './schemas.js';

describe('GateStatusSchema (hook A: reserved needs_revision)', () => {
  it('accepts the reserved needs_revision value', () => {
    expect(GateStatusSchema.parse('needs_revision')).toBe('needs_revision');
  });
});

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

describe('StageMachine subtask methods (Phase 3)', () => {
  function mkSpec() {
    return new StageMachine().createSpec({ ticketId: 'ABC-1', title: 'x' });
  }

  describe('setSubtasks', () => {
    it('replaces the develop subtask list wholesale', () => {
      const sm = new StageMachine();
      const spec = sm.setSubtasks(mkSpec(), [
        { description: 'Write unit tests' },
        { description: 'Implement feature' },
      ]);
      const develop = spec.stages.find((s) => s.id === 'develop')!;
      expect(develop.subtasks).toHaveLength(2);
      expect(develop.subtasks![0].description).toBe('Write unit tests');
      expect(develop.subtasks![1].description).toBe('Implement feature');
    });

    it('assigns unique ids to each subtask', () => {
      const sm = new StageMachine();
      const spec = sm.setSubtasks(mkSpec(), [
        { description: 'A' },
        { description: 'B' },
        { description: 'C' },
      ]);
      const ids = spec.stages.find((s) => s.id === 'develop')!.subtasks!.map((t) => t.id);
      expect(new Set(ids).size).toBe(3);
    });

    it('all new subtasks start as not completed', () => {
      const sm = new StageMachine();
      const spec = sm.setSubtasks(mkSpec(), [{ description: 'Do something' }]);
      const task = spec.stages.find((s) => s.id === 'develop')!.subtasks![0];
      expect(task.completed).toBe(false);
    });

    it('preserves prompt and requirementRef if supplied', () => {
      const sm = new StageMachine();
      const spec = sm.setSubtasks(mkSpec(), [
        { description: 'Task', prompt: 'Hint', requirementRef: 'REQ-1' },
      ]);
      const task = spec.stages.find((s) => s.id === 'develop')!.subtasks![0];
      expect(task.prompt).toBe('Hint');
      expect(task.requirementRef).toBe('REQ-1');
    });

    it('preserves order — first in, first out', () => {
      const sm = new StageMachine();
      const descs = ['Alpha', 'Beta', 'Gamma'];
      const spec = sm.setSubtasks(mkSpec(), descs.map((d) => ({ description: d })));
      const out = spec.stages.find((s) => s.id === 'develop')!.subtasks!.map((t) => t.description);
      expect(out).toEqual(descs);
    });

    it('throws when called for a non-develop stage', () => {
      const sm = new StageMachine();
      expect(() => sm.setSubtasks(mkSpec(), [{ description: 'x' }], 'spec')).toThrow(
        /only.*develop/i
      );
    });

    it('updating subtasks bumps updatedAt', () => {
      const sm = new StageMachine();
      const before = mkSpec();
      const after = sm.setSubtasks(before, [{ description: 'x' }]);
      expect(after.updatedAt >= before.updatedAt).toBe(true);
    });
  });

  describe('toggleSubtask', () => {
    it('flips a false task to true', () => {
      const sm = new StageMachine();
      let spec = sm.setSubtasks(mkSpec(), [{ description: 'T1' }]);
      const id = spec.stages.find((s) => s.id === 'develop')!.subtasks![0].id;
      spec = sm.toggleSubtask(spec, id);
      expect(spec.stages.find((s) => s.id === 'develop')!.subtasks![0].completed).toBe(true);
    });

    it('flips a true task back to false', () => {
      const sm = new StageMachine();
      let spec = sm.setSubtasks(mkSpec(), [{ description: 'T1' }]);
      const id = spec.stages.find((s) => s.id === 'develop')!.subtasks![0].id;
      spec = sm.toggleSubtask(spec, id); // → true
      spec = sm.toggleSubtask(spec, id); // → false
      expect(spec.stages.find((s) => s.id === 'develop')!.subtasks![0].completed).toBe(false);
    });

    it('only toggles the targeted subtask, leaves others unchanged', () => {
      const sm = new StageMachine();
      let spec = sm.setSubtasks(mkSpec(), [
        { description: 'T1' },
        { description: 'T2' },
        { description: 'T3' },
      ]);
      const subtasks = spec.stages.find((s) => s.id === 'develop')!.subtasks!;
      spec = sm.toggleSubtask(spec, subtasks[1].id);
      const after = spec.stages.find((s) => s.id === 'develop')!.subtasks!;
      expect(after[0].completed).toBe(false);
      expect(after[1].completed).toBe(true);
      expect(after[2].completed).toBe(false);
    });

    it('throws on unknown subtask id', () => {
      const sm = new StageMachine();
      const spec = sm.setSubtasks(mkSpec(), [{ description: 'x' }]);
      expect(() => sm.toggleSubtask(spec, 'nonexistent')).toThrow(/unknown subtask/i);
    });

    it('bumps updatedAt', () => {
      const sm = new StageMachine();
      let spec = sm.setSubtasks(mkSpec(), [{ description: 'T' }]);
      const id = spec.stages.find((s) => s.id === 'develop')!.subtasks![0].id;
      const before = spec.updatedAt;
      spec = sm.toggleSubtask(spec, id);
      expect(spec.updatedAt >= before).toBe(true);
    });
  });

  describe('derived aiStatus from subtasks', () => {
    it('aiStatus stays stubbed when subtasks are empty', () => {
      const sm = new StageMachine();
      const spec = sm.setSubtasks(mkSpec(), []);
      expect(spec.stages.find((s) => s.id === 'develop')!.aiStatus).toBe('stubbed');
    });

    it('aiStatus is in_progress when subtasks exist but none completed', () => {
      const sm = new StageMachine();
      let spec = sm.setSubtasks(mkSpec(), [{ description: 'T1' }, { description: 'T2' }]);
      // Manually open the stage so it's not stubbed (simulate being reached)
      const develop = spec.stages.find((s) => s.id === 'develop')!;
      develop.aiCapability = 'auto';
      develop.aiStatus = 'not_started';
      spec = sm.setSubtasks(spec, [{ description: 'T1' }, { description: 'T2' }]);
      expect(spec.stages.find((s) => s.id === 'develop')!.aiStatus).toBe('in_progress');
    });

    it('aiStatus becomes done only when ALL subtasks are checked', () => {
      const sm = new StageMachine();
      let spec = sm.setSubtasks(mkSpec(), [{ description: 'T1' }, { description: 'T2' }]);
      const develop = spec.stages.find((s) => s.id === 'develop')!;
      develop.aiCapability = 'auto';
      develop.aiStatus = 'not_started';
      spec = sm.setSubtasks(spec, [{ description: 'T1' }, { description: 'T2' }]);

      const ids = spec.stages.find((s) => s.id === 'develop')!.subtasks!.map((t) => t.id);
      spec = sm.toggleSubtask(spec, ids[0]);
      expect(spec.stages.find((s) => s.id === 'develop')!.aiStatus).toBe('in_progress');

      spec = sm.toggleSubtask(spec, ids[1]);
      expect(spec.stages.find((s) => s.id === 'develop')!.aiStatus).toBe('done');
    });

    it('un-checking a task reverts aiStatus from done back to in_progress', () => {
      const sm = new StageMachine();
      let spec = sm.setSubtasks(mkSpec(), [{ description: 'T1' }]);
      const develop = spec.stages.find((s) => s.id === 'develop')!;
      develop.aiCapability = 'auto';
      develop.aiStatus = 'not_started';
      spec = sm.setSubtasks(spec, [{ description: 'T1' }]);

      const id = spec.stages.find((s) => s.id === 'develop')!.subtasks![0].id;
      spec = sm.toggleSubtask(spec, id); // done
      spec = sm.toggleSubtask(spec, id); // back to in_progress
      expect(spec.stages.find((s) => s.id === 'develop')!.aiStatus).toBe('in_progress');
    });

    it('gate rule unchanged: DEVELOP gate still needs human approval to advance', () => {
      const sm = new StageMachine();
      let spec = sm.setSubtasks(mkSpec(), [{ description: 'T1' }]);
      const develop = spec.stages.find((s) => s.id === 'develop')!;
      develop.aiCapability = 'auto';
      develop.aiStatus = 'not_started';
      spec = sm.setSubtasks(spec, [{ description: 'T1' }]);

      const id = spec.stages.find((s) => s.id === 'develop')!.subtasks![0].id;
      spec = sm.toggleSubtask(spec, id);
      // aiStatus is now done but gate is still not_ready — advance must fail
      expect(spec.stages.find((s) => s.id === 'develop')!.aiStatus).toBe('done');
      expect(() => sm.advance(spec, 'develop')).toThrow(GateNotApprovedError);
    });
  });
});
