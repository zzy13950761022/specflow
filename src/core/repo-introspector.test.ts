import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { introspectRepo, type RepoBrief } from './repo-introspector.js';

let repo: string;

beforeEach(async () => {
  repo = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-intro-'));
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('introspectRepo — build tool detection', () => {
  it('detects Maven from pom.xml', async () => {
    await fs.writeFile(join(repo, 'pom.xml'), '<project/>', 'utf-8');
    const brief = await introspectRepo(repo);
    expect(brief.buildTool).toBe('maven');
  });

  it('detects Gradle from build.gradle', async () => {
    await fs.writeFile(join(repo, 'build.gradle'), 'plugins {}', 'utf-8');
    const brief = await introspectRepo(repo);
    expect(brief.buildTool).toBe('gradle');
  });

  it('detects npm from package.json', async () => {
    await fs.writeFile(join(repo, 'package.json'), '{"name":"test"}', 'utf-8');
    const brief = await introspectRepo(repo);
    expect(brief.buildTool).toBe('npm');
  });

  it('detects pytest from setup.py', async () => {
    await fs.writeFile(join(repo, 'setup.py'), 'from setuptools import setup', 'utf-8');
    const brief = await introspectRepo(repo);
    expect(brief.buildTool).toBe('python');
  });

  it('detects pytest from pyproject.toml', async () => {
    await fs.writeFile(join(repo, 'pyproject.toml'), '[tool.poetry]', 'utf-8');
    const brief = await introspectRepo(repo);
    expect(brief.buildTool).toBe('python');
  });

  it('returns unknown when no build file found', async () => {
    const brief = await introspectRepo(repo);
    expect(brief.buildTool).toBe('unknown');
  });
});

describe('introspectRepo — test framework detection', () => {
  it('detects JUnit from pom.xml with junit dependency', async () => {
    await fs.writeFile(
      join(repo, 'pom.xml'),
      '<project><dependencies><dependency><groupId>junit</groupId></dependency></dependencies></project>',
      'utf-8'
    );
    const brief = await introspectRepo(repo);
    expect(brief.testFramework).toContain('junit');
  });

  it('detects Jest from package.json devDependencies', async () => {
    await fs.writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '^29' } }),
      'utf-8'
    );
    const brief = await introspectRepo(repo);
    expect(brief.testFramework).toContain('jest');
  });

  it('detects Vitest from package.json devDependencies', async () => {
    await fs.writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ devDependencies: { vitest: '^1' } }),
      'utf-8'
    );
    const brief = await introspectRepo(repo);
    expect(brief.testFramework).toContain('vitest');
  });

  it('detects pytest from requirements.txt', async () => {
    await fs.writeFile(join(repo, 'requirements.txt'), 'pytest==7.4.0\nrequests==2.31', 'utf-8');
    const brief = await introspectRepo(repo);
    expect(brief.testFramework).toContain('pytest');
  });

  it('returns unknown when no test framework detected', async () => {
    const brief = await introspectRepo(repo);
    expect(brief.testFramework).toBe('unknown');
  });
});

describe('introspectRepo — CLAUDE.md', () => {
  it('reads CLAUDE.md content when present', async () => {
    await fs.writeFile(join(repo, 'CLAUDE.md'), '# Project context\nUse our API patterns.', 'utf-8');
    const brief = await introspectRepo(repo);
    expect(brief.claudeMd).toContain('Project context');
    expect(brief.claudeMd).toContain('Use our API patterns');
  });

  it('returns null when CLAUDE.md is absent', async () => {
    const brief = await introspectRepo(repo);
    expect(brief.claudeMd).toBeNull();
  });
});

describe('introspectRepo — sample source file', () => {
  it('picks a representative source file from src/ for npm repo', async () => {
    await fs.writeFile(join(repo, 'package.json'), '{"name":"test"}', 'utf-8');
    const srcDir = join(repo, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(join(srcDir, 'core.ts'), 'export const x = 1;', 'utf-8');
    const brief = await introspectRepo(repo);
    expect(brief.sampleFile).not.toBeNull();
    expect(brief.sampleFile!.path).toContain('core.ts');
    expect(brief.sampleFile!.content).toContain('export const x');
  });

  it('returns null when no source files found', async () => {
    const brief = await introspectRepo(repo);
    expect(brief.sampleFile).toBeNull();
  });
});

describe('introspectRepo — RepoBrief shape', () => {
  it('returns all required fields', async () => {
    const brief: RepoBrief = await introspectRepo(repo);
    expect(brief).toHaveProperty('repoPath');
    expect(brief).toHaveProperty('buildTool');
    expect(brief).toHaveProperty('testFramework');
    expect(brief).toHaveProperty('claudeMd');
    expect(brief).toHaveProperty('sampleFile');
    expect(brief).toHaveProperty('blueprintDefaults');
  });

  it('includes blueprint defaults in the brief', async () => {
    const brief = await introspectRepo(repo);
    expect(brief.blueprintDefaults).toHaveProperty('spec');
    expect(brief.blueprintDefaults).toHaveProperty('requirements');
    expect(brief.blueprintDefaults).toHaveProperty('develop');
  });
});
