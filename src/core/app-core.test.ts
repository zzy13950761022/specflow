import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppCore } from './app-core.js';
import { GateNotApprovedError } from './stage-machine.js';

let home: string;
let repo: string;
let app: AppCore;
let repoId: string;

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-home-'));
  repo = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-repo-'));
  process.env.AI_PILOT_HOME = home;
  app = new AppCore();
  const entry = await app.addRepo(repo);
  repoId = entry.id;
});

afterEach(async () => {
  delete process.env.AI_PILOT_HOME;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(repo, { recursive: true, force: true });
});

describe('AppCore end-to-end Stage 0 -> 1 loop', () => {
  it('creates a spec and emits spec.created', async () => {
    const events: string[] = [];
    app.events.subscribe((e) => events.push(e.type));
    const spec = await app.createSpec(repoId, 'ABC-1', 'Checkout Tax');
    expect(spec.ticketId).toBe('ABC-1');
    expect(events).toContain('spec.created');
  });

  it('rejects a duplicate ticket', async () => {
    await app.createSpec(repoId, 'ABC-1', 'x');
    await expect(app.createSpec(repoId, 'ABC-1', 'x')).rejects.toThrow(/already exists/i);
  });

  it('record_ai_output writes the artifact to disk and flips gate to pending_review', async () => {
    await app.createSpec(repoId, 'ABC-1', 'Checkout Tax');
    const spec = await app.recordAiOutput(repoId, 'ABC-1', 'spec', '# The spec body');
    expect(spec.stages[0].gate.status).toBe('pending_review');
    // Stage-0 product lives at the spec's specPath under .specflow/specs/
    const onDisk = await fs.readFile(join(repo, '.specflow', 'specs', 'ABC-1-checkout-tax.md'), 'utf-8');
    expect(onDisk).toBe('# The spec body');
  });

  it('REFUSES advance before approval, then allows it after', async () => {
    await app.createSpec(repoId, 'ABC-1', 'x');
    await app.recordAiOutput(repoId, 'ABC-1', 'spec', '# body');
    await expect(app.advance(repoId, 'ABC-1', 'spec')).rejects.toBeInstanceOf(GateNotApprovedError);

    await app.approve(repoId, 'ABC-1', 'spec');
    const advanced = await app.advance(repoId, 'ABC-1', 'spec');
    expect(advanced.stages[1].id).toBe('requirements');
    expect(advanced.stages[1].aiStatus).toBe('not_started');
  });

  it('every mutation emits spec.updated', async () => {
    await app.createSpec(repoId, 'ABC-1', 'x');
    const updates: string[] = [];
    app.events.subscribe((e) => {
      if (e.type === 'spec.updated') updates.push(e.spec.ticketId);
    });
    await app.recordAiOutput(repoId, 'ABC-1', 'spec', '# body');
    await app.approve(repoId, 'ABC-1', 'spec');
    await app.advance(repoId, 'ABC-1', 'spec');
    expect(updates.length).toBe(3);
  });
});

describe('AppCore prompt rendering with upstream context', () => {
  it('feeds the approved spec body into the requirements prompt', async () => {
    await app.createSpec(repoId, 'ABC-1', 'Checkout Tax');
    await app.recordAiOutput(repoId, 'ABC-1', 'spec', 'APPROVED SPEC CONTENT');
    await app.approve(repoId, 'ABC-1', 'spec');
    await app.advance(repoId, 'ABC-1', 'spec');

    const prompt = await app.getStagePrompt(repoId, 'ABC-1', 'requirements');
    expect(prompt.content).toContain('APPROVED SPEC CONTENT');
    expect(prompt.source).toBe('blueprint-default');
  });

  it('stage-0 prompt interpolates ticket + title', async () => {
    await app.createSpec(repoId, 'ABC-1', 'Checkout Tax');
    const prompt = await app.getStagePrompt(repoId, 'ABC-1', 'spec');
    expect(prompt.content).toContain('ABC-1');
    expect(prompt.content).toContain('Checkout Tax');
  });
});

describe('AppCore readArtifact (review-before-approve)', () => {
  it('returns the recorded artifact content for a stage', async () => {
    await app.createSpec(repoId, 'ABC-1', 'Checkout Tax');
    await app.recordAiOutput(repoId, 'ABC-1', 'spec', '# The spec body\n\nDetails here.');
    const content = await app.readArtifact(repoId, 'ABC-1', 'spec');
    expect(content).toBe('# The spec body\n\nDetails here.');
  });

  it('returns null for a stage with no artifact yet', async () => {
    await app.createSpec(repoId, 'ABC-1', 'x');
    expect(await app.readArtifact(repoId, 'ABC-1', 'design')).toBeNull();
  });

  it('throws for an unknown spec', async () => {
    await expect(app.readArtifact(repoId, 'NOPE-1', 'spec')).rejects.toThrow(/unknown spec/i);
  });
});

describe('AppCore readArtifactData (requirements sidecar)', () => {
  it('round-trips the structured requirements sidecar', async () => {
    await app.createSpec(repoId, 'REQ-1', 'Requirements');
    await app.recordAiOutput(repoId, 'REQ-1', 'requirements', '# summary', {
      kind: 'requirements',
      data: {
        affectedFiles: [{ path: 'src/x.ts', impact: 'change' }],
        reuse: [{ title: 'ReuseMe' }],
        buildFromScratch: [],
        dataMigration: [],
        integrations: [],
      },
    });
    const data = (await app.readArtifactData(repoId, 'REQ-1', 'requirements')) as {
      affectedFiles: Array<{ path: string; impact?: string }>;
      reuse: Array<{ title: string }>;
    };
    expect(data).not.toBeNull();
    expect(data.affectedFiles[0].path).toBe('src/x.ts');
    expect(data.reuse[0].title).toBe('ReuseMe');
  });

  it('returns null for a stage whose artifact is not a requirements kind', async () => {
    await app.createSpec(repoId, 'REQ-1', 'x');
    await app.recordAiOutput(repoId, 'REQ-1', 'spec', '# plain markdown');
    expect(await app.readArtifactData(repoId, 'REQ-1', 'spec')).toBeNull();
  });

  it('returns null for a requirements stage with no artifact yet', async () => {
    await app.createSpec(repoId, 'REQ-1', 'x');
    expect(await app.readArtifactData(repoId, 'REQ-1', 'requirements')).toBeNull();
  });
});

describe('AppCore artifactHistory snapshot (hook B)', () => {
  it('appends a {path, at} history entry on each record, and the file exists', async () => {
    await app.createSpec(repoId, 'ABC-1', 'x');
    const spec = await app.recordAiOutput(repoId, 'ABC-1', 'spec', '# v1');
    const stage = spec.stages[0];
    expect(stage.artifactHistory).toHaveLength(1);
    expect(stage.artifactHistory![0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const snapshot = await fs.readFile(join(repo, stage.artifactHistory![0].path), 'utf-8');
    expect(snapshot).toBe('# v1');
  });
});

describe('AppCore repo lifecycle', () => {
  it('removing a repo never deletes repo files', async () => {
    await app.createSpec(repoId, 'ABC-1', 'x');
    await app.removeRepo(repoId);
    expect(await app.listRepos()).toHaveLength(0);
    // the spec json still physically exists
    const stillThere = await fs
      .access(join(repo, '.specflow', 'specs', 'ABC-1.json'))
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(true);
  });
});

describe('AppCore subtask management (Phase 3)', () => {
  it('setSubtasks persists tasks and emits spec.updated', async () => {
    await app.createSpec(repoId, 'TASK-1', 'Feature');
    const events: string[] = [];
    app.events.subscribe((e) => events.push(e.type));

    const spec = await app.setDevelopSubtasks(repoId, 'TASK-1', [
      { description: 'Write unit tests' },
      { description: 'Implement feature' },
    ]);

    const develop = spec.stages.find((s) => s.id === 'develop')!;
    expect(develop.subtasks).toHaveLength(2);
    expect(develop.subtasks![0].description).toBe('Write unit tests');
    expect(events).toContain('spec.updated');
  });

  it('setSubtasks persists to disk — round-trip via getSpec', async () => {
    await app.createSpec(repoId, 'TASK-1', 'Feature');
    await app.setDevelopSubtasks(repoId, 'TASK-1', [
      { description: 'Alpha' },
      { description: 'Beta' },
    ]);

    const read = await app.getSpec(repoId, 'TASK-1');
    const develop = read!.stages.find((s) => s.id === 'develop')!;
    expect(develop.subtasks).toHaveLength(2);
    expect(develop.subtasks![0].description).toBe('Alpha');
    expect(develop.subtasks![1].description).toBe('Beta');
  });

  it('toggleSubtask flips the targeted task and emits spec.updated', async () => {
    await app.createSpec(repoId, 'TASK-1', 'Feature');
    let spec = await app.setDevelopSubtasks(repoId, 'TASK-1', [
      { description: 'T1' },
      { description: 'T2' },
    ]);
    const id = spec.stages.find((s) => s.id === 'develop')!.subtasks![0].id;

    const updates: string[] = [];
    app.events.subscribe((e) => { if (e.type === 'spec.updated') updates.push(e.spec.ticketId); });

    spec = await app.toggleSubtask(repoId, 'TASK-1', id);
    expect(spec.stages.find((s) => s.id === 'develop')!.subtasks![0].completed).toBe(true);
    expect(updates).toContain('TASK-1');
  });

  it('aiStatus becomes done when all subtasks are toggled on', async () => {
    await app.createSpec(repoId, 'TASK-1', 'Feature');
    // Phase 5: develop is now auto, so toggling the only subtask to completed makes aiStatus 'done'.
    let spec = await app.setDevelopSubtasks(repoId, 'TASK-1', [{ description: 'Only one' }]);
    const id = spec!.stages.find((s) => s.id === 'develop')!.subtasks![0].id;
    spec = await app.toggleSubtask(repoId, 'TASK-1', id);
    // Phase 5: all stages are auto, so aiStatus derives to 'done' when all tasks completed.
    expect(spec!.stages.find((s) => s.id === 'develop')!.aiStatus).toBe('done');
  });
});
