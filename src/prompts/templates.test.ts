import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PromptTemplates, assertAllDefaultsPresent } from './templates.js';
import { STAGE_IDS } from '../core/schemas.js';

let repo: string;

beforeEach(async () => {
  repo = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-tpl-'));
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('PromptTemplates blueprint defaults', () => {
  it('has a default for every one of the 8 stages', () => {
    expect(() => assertAllDefaultsPresent()).not.toThrow();
  });

  it('falls back to the blueprint default when the repo has no curated template', async () => {
    const t = new PromptTemplates();
    const resolved = await t.resolve(repo, 'spec');
    expect(resolved.source).toBe('blueprint-default');
    expect(resolved.content).toContain('Stage 0 — Spec');
  });

  it('stage 7 default carries the log-sanitization governance rule', async () => {
    const t = new PromptTemplates();
    const resolved = await t.resolve(repo, 'ops');
    expect(resolved.content).toMatch(/Never paste raw production data/i);
    expect(resolved.content).toContain('[REDACTED]');
  });

  it('stage 6 default carries PCI/GDPR controls', async () => {
    const t = new PromptTemplates();
    const resolved = await t.resolve(repo, 'deploy');
    expect(resolved.content).toMatch(/PCI\/GDPR/);
  });
});

describe('PromptTemplates per-repo resolution (the primary path)', () => {
  it('prefers a <repo>/.specflow/templates/{stage}.md over the default (repo-draft)', async () => {
    const dir = join(repo, '.specflow', 'templates');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'spec.md'), '# Curated spec prompt for THIS repo', 'utf-8');

    const t = new PromptTemplates();
    const resolved = await t.resolve(repo, 'spec');
    expect(resolved.source).toBe('repo-draft');
    expect(resolved.content).toContain('Curated spec prompt for THIS repo');
  });
});

describe('PromptTemplates.render interpolation', () => {
  it('interpolates ticketId and title', async () => {
    const t = new PromptTemplates();
    const r = await t.render(repo, 'spec', { ticketId: 'ABC-1', title: 'Checkout Tax' });
    expect(r.content).toContain('ABC-1');
    expect(r.content).toContain('Checkout Tax');
  });

  it('interpolates the upstream artifact into the requirements prompt', async () => {
    const t = new PromptTemplates();
    const r = await t.render(repo, 'requirements', {
      ticketId: 'ABC-1',
      title: 'x',
      upstreamArtifact: 'APPROVED SPEC BODY',
    });
    expect(r.content).toContain('APPROVED SPEC BODY');
  });
});

describe('PromptTemplates sub-agent generator seam (Phase 2)', () => {
  it('generateCuratedTemplate returns a RepoBrief (no longer throws)', async () => {
    const t = new PromptTemplates();
    const brief = await t.generateCuratedTemplate(repo, 'spec');
    expect(brief).toHaveProperty('buildTool');
    expect(brief).toHaveProperty('testFramework');
    expect(brief).toHaveProperty('blueprintDefaults');
  });
});

describe('PromptTemplates.writeRepoTemplate + resolve source enum', () => {
  it('writeRepoTemplate persists to <repo>/.specflow/templates/{stage}.md', async () => {
    const t = new PromptTemplates();
    await t.writeRepoTemplate(repo, 'spec', '# My curated spec prompt');
    const onDisk = await fs.readFile(join(repo, '.specflow', 'templates', 'spec.md'), 'utf-8');
    expect(onDisk).toBe('# My curated spec prompt');
  });

  it('resolve returns repo-draft after writeRepoTemplate (no meta file)', async () => {
    const t = new PromptTemplates();
    await t.writeRepoTemplate(repo, 'test', '# Test prompt');
    const resolved = await t.resolve(repo, 'test');
    expect(resolved.source).toBe('repo-draft');
  });

  it('resolve returns repo-curated after marking as curated', async () => {
    const t = new PromptTemplates();
    await t.writeRepoTemplate(repo, 'design', '# Design prompt');
    await t.markTemplateCurated(repo, 'design');
    const resolved = await t.resolve(repo, 'design');
    expect(resolved.source).toBe('repo-curated');
  });

  it('resolve still returns blueprint-default when no repo template exists', async () => {
    const t = new PromptTemplates();
    const resolved = await t.resolve(repo, 'deploy');
    expect(resolved.source).toBe('blueprint-default');
  });

  it('listTemplates returns all 8 stages with their source', async () => {
    const t = new PromptTemplates();
    await t.writeRepoTemplate(repo, 'spec', '# Spec');
    await t.markTemplateCurated(repo, 'spec');
    await t.writeRepoTemplate(repo, 'design', '# Design draft');
    const list = await t.listTemplates(repo);
    expect(list).toHaveLength(8);
    const spec = list.find((t) => t.stageId === 'spec');
    expect(spec?.source).toBe('repo-curated');
    const design = list.find((t) => t.stageId === 'design');
    expect(design?.source).toBe('repo-draft');
    const ops = list.find((t) => t.stageId === 'ops');
    expect(ops?.source).toBe('blueprint-default');
  });
});

describe('coverage: all stage ids resolvable', () => {
  it('resolves a template for every stage id', async () => {
    const t = new PromptTemplates();
    for (const id of STAGE_IDS) {
      const r = await t.resolve(repo, id);
      expect(r.content.length).toBeGreaterThan(0);
    }
  });
});
