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
    // Stage-0 product lives in specs/{TICKET}.md
    const onDisk = await fs.readFile(join(repo, 'specs', 'ABC-1.md'), 'utf-8');
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
