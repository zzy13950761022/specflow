import { promises as fs } from 'fs';
import { join } from 'path';
import { BLUEPRINT_DEFAULTS, type BlueprintDefaults } from '../prompts/template-defaults.js';
import type { StageId } from './schemas.js';

export type BuildTool = 'maven' | 'gradle' | 'npm' | 'python' | 'unknown';

export interface SampleFile {
  path: string;
  content: string;
}

export interface RepoBrief {
  repoPath: string;
  buildTool: BuildTool;
  testFramework: string;
  claudeMd: string | null;
  sampleFile: SampleFile | null;
  blueprintDefaults: BlueprintDefaults;
}

async function exists(path: string): Promise<boolean> {
  return fs.access(path).then(() => true, () => false);
}

async function readOptional(path: string): Promise<string | null> {
  return fs.readFile(path, 'utf-8').catch(() => null);
}

async function detectBuildTool(repoPath: string): Promise<BuildTool> {
  if (await exists(join(repoPath, 'pom.xml'))) return 'maven';
  if (
    (await exists(join(repoPath, 'build.gradle'))) ||
    (await exists(join(repoPath, 'build.gradle.kts')))
  )
    return 'gradle';
  if (await exists(join(repoPath, 'package.json'))) return 'npm';
  if (
    (await exists(join(repoPath, 'setup.py'))) ||
    (await exists(join(repoPath, 'pyproject.toml'))) ||
    (await exists(join(repoPath, 'setup.cfg')))
  )
    return 'python';
  return 'unknown';
}

async function detectTestFramework(repoPath: string, buildTool: BuildTool): Promise<string> {
  if (buildTool === 'npm') {
    const pkg = await readOptional(join(repoPath, 'package.json'));
    if (pkg) {
      const parsed = JSON.parse(pkg) as Record<string, Record<string, string>>;
      const deps = { ...parsed.dependencies, ...parsed.devDependencies };
      if (deps['vitest']) return 'vitest';
      if (deps['jest']) return 'jest';
      if (deps['mocha']) return 'mocha';
      if (deps['@playwright/test']) return 'playwright';
    }
  }

  if (buildTool === 'maven') {
    const pom = await readOptional(join(repoPath, 'pom.xml'));
    if (pom) {
      if (pom.includes('junit')) return 'junit';
      if (pom.includes('testng')) return 'testng';
    }
  }

  if (buildTool === 'gradle') {
    const build =
      (await readOptional(join(repoPath, 'build.gradle'))) ??
      (await readOptional(join(repoPath, 'build.gradle.kts')));
    if (build) {
      if (build.includes('junit')) return 'junit';
      if (build.includes('testng')) return 'testng';
      if (build.includes('kotest')) return 'kotest';
    }
  }

  if (buildTool === 'python' || buildTool === 'unknown') {
    const req = await readOptional(join(repoPath, 'requirements.txt'));
    if (req?.includes('pytest')) return 'pytest';
    const pyproject = await readOptional(join(repoPath, 'pyproject.toml'));
    if (pyproject?.includes('pytest')) return 'pytest';
  }

  return 'unknown';
}

const SOURCE_EXTENSIONS: Record<BuildTool, string[]> = {
  maven: ['.java', '.kt'],
  gradle: ['.java', '.kt', '.groovy'],
  npm: ['.ts', '.tsx', '.js', '.jsx'],
  python: ['.py'],
  unknown: ['.ts', '.js', '.java', '.py'],
};

const SOURCE_DIRS = ['src', 'lib', 'app', 'source'];

async function collectFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectFiles(fullPath).catch(() => []);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

async function findSampleFile(repoPath: string, buildTool: BuildTool): Promise<SampleFile | null> {
  const exts = SOURCE_EXTENSIONS[buildTool];
  for (const dir of SOURCE_DIRS) {
    const dirPath = join(repoPath, dir);
    let allFiles: string[];
    try {
      allFiles = await collectFiles(dirPath);
    } catch {
      continue;
    }
    for (const fullPath of allFiles) {
      if (!exts.some((ext) => fullPath.endsWith(ext))) continue;
      const content = await readOptional(fullPath);
      if (content && content.trim().length > 0) {
        return { path: fullPath.replace(repoPath + '/', ''), content: content.slice(0, 2000) };
      }
    }
  }
  return null;
}

/**
 * Inspect a repo and return a structured brief that a Claude agent uses to
 * produce curated 8-stage prompt templates. Pure/async — no side effects.
 */
export async function introspectRepo(repoPath: string): Promise<RepoBrief> {
  const buildTool = await detectBuildTool(repoPath);
  const [testFramework, claudeMd, sampleFile] = await Promise.all([
    detectTestFramework(repoPath, buildTool),
    readOptional(join(repoPath, 'CLAUDE.md')),
    findSampleFile(repoPath, buildTool),
  ]);

  return {
    repoPath,
    buildTool,
    testFramework,
    claudeMd,
    sampleFile,
    blueprintDefaults: BLUEPRINT_DEFAULTS,
  };
}
