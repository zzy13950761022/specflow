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
  it('prefers a curated <repo>/.specflow/templates/{stage}.md over the default', async () => {
    const dir = join(repo, '.specflow', 'templates');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'spec.md'), '# Curated spec prompt for THIS repo', 'utf-8');

    const t = new PromptTemplates();
    const resolved = await t.resolve(repo, 'spec');
    expect(resolved.source).toBe('repo');
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

describe('PromptTemplates sub-agent generator seam', () => {
  it('generateCuratedTemplate is a declared seam that throws in v1', async () => {
    const t = new PromptTemplates();
    await expect(t.generateCuratedTemplate(repo, 'spec')).rejects.toThrow(/not implemented in v1/i);
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
