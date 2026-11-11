import { beforeEach, afterEach, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCheck, fingerprint, recoverRepositoryCheck, assertEvidence } from './check-runner.js';

let repo: string;
beforeEach(async () => { repo = await fs.mkdtemp(join(tmpdir(), 'check-runner-')); await fs.writeFile(join(repo, 'source.ts'), 'const x = 1'); });
afterEach(async () => { await fs.rm(repo, { recursive: true, force: true }); });
async function configure(code: string, coverage = false, timeoutMs = 1000) {
  await fs.mkdir(join(repo, '.specflow'), { recursive: true });
  await fs.writeFile(join(repo, '.specflow/checks.json'), JSON.stringify({
    test: { command: process.execPath, args: ['-e', code], ...(coverage ? { coverageReport: 'coverage/coverage-summary.json' } : {}), timeoutMs },
    build: { command: process.execPath, args: ['-e', code], timeoutMs },
  }));
}
it('captures actual command success and output without stdout pollution', async () => {
  await configure('console.log("built")');
  const result = await runCheck(repo, 'CHECK-1', 'build');
  expect(result.exitCode).toBe(0);
  expect(result.codeFingerprint).toBe(await fingerprint(repo));
  expect(await fs.readFile(join(repo, result.outputPath), 'utf8')).toContain('built');
});
it('managed checks use canonical command authority instead of agent-writable configuration', async () => {
  await configure('require("fs").writeFileSync("escaped-host-command", "bad")');
  const canonical = await fs.mkdtemp(join(tmpdir(), 'canonical-checks-'));
  try {
    await fs.mkdir(join(canonical, '.specflow'));
    await fs.writeFile(join(canonical, '.specflow', 'checks.json'), JSON.stringify({ build: { command: process.execPath, args: ['-e', 'console.log("canonical")'] } }));
    const evidence = await runCheck(repo, 'CHECK-1', 'build', 'trusted-run', canonical);
    expect(evidence.args).toEqual(['-e', 'console.log("canonical")']);
    await expect(fs.stat(join(repo, 'escaped-host-command'))).rejects.toThrow();
  } finally { await fs.rm(canonical, { recursive: true, force: true }); }
});
it('captures a failing exit code', async () => {
  await configure('process.exit(2)');
  expect((await runCheck(repo, 'CHECK-1', 'build')).exitCode).toBe(2);
});
it('parses fresh tool coverage instead of an AI estimate', async () => {
  await configure('const fs=require("fs");fs.mkdirSync("coverage",{recursive:true});fs.writeFileSync("coverage/coverage-summary.json",JSON.stringify({total:{lines:{pct:91,total:100,covered:91}}}))', true);
  expect((await runCheck(repo, 'CHECK-1', 'test')).coverage).toBe(0.91);
});
it('does not accept an old report when the command writes none', async () => {
  await configure('process.exit(0)', true);
  await fs.mkdir(join(repo, 'coverage'));
  await fs.writeFile(join(repo, 'coverage/coverage-summary.json'), '{"total":{"lines":{"pct":100}}}');
  expect((await runCheck(repo, 'CHECK-1', 'test')).coverage).toBeUndefined();
});
it('marks code changes during execution invalid', async () => {
  await configure('require("fs").writeFileSync("source.ts","changed")');
  expect((await runCheck(repo, 'CHECK-1', 'build')).codeChanged).toBe(true);
});
it('bounds execution time', async () => {
  await configure('setInterval(()=>{},100)', false, 50);
  expect((await runCheck(repo, 'CHECK-1', 'build')).timedOut).toBe(true);
});
it('rejects report paths outside generated coverage directory', async () => {
  await configure('process.exit(0)', true);
  const config = JSON.parse(await fs.readFile(join(repo, '.specflow/checks.json'), 'utf8'));
  config.test.coverageReport = '../outside.json';
  await fs.writeFile(join(repo, '.specflow/checks.json'), JSON.stringify(config));
  await expect(runCheck(repo, 'CHECK-1', 'test')).rejects.toThrow(/coverage/i);
});
it('fingerprints source folders named build rather than treating them as generated output', async () => {
  await fs.mkdir(join(repo, 'src/build'), { recursive: true });
  await fs.writeFile(join(repo, 'src/build/config.ts'), 'old');
  const before = await fingerprint(repo);
  await fs.writeFile(join(repo, 'src/build/config.ts'), 'new');
  expect(await fingerprint(repo)).not.toBe(before);
});
it('rejects overlapping repository checks so tickets cannot share coverage evidence', async () => {
  await configure('const fs=require("fs");fs.writeFileSync(".specflow/started","1");setTimeout(()=>{fs.mkdirSync("coverage",{recursive:true});fs.writeFileSync("coverage/coverage-summary.json",JSON.stringify({total:{lines:{pct:90,total:100,covered:90}}}))},150)', true);
  const first = runCheck(repo, 'CHECK-1', 'test');
  while (!(await fs.stat(join(repo, '.specflow/started')).catch(() => null))) await new Promise((resolve) => setTimeout(resolve, 1));
  await expect(runCheck(repo, 'CHECK-2', 'test')).rejects.toThrow(/repository.*check|check.*repository/i);
  expect((await first).coverage).toBe(0.9);
  await configure('process.exit(0)', true);
  expect((await runCheck(repo, 'CHECK-2', 'test')).coverage).toBeUndefined();
});
it.each(['missing', 'truncated', 'recovery'] as const)('recovers aged incomplete %s lock metadata', async (kind) => {
  await configure('process.exit(0)');
  const lock = join(repo, '.specflow/repository-check.lock');
  await fs.mkdir(lock);
  if (kind === 'truncated') await fs.writeFile(join(lock, 'owner.json'), '{');
  if (kind === 'recovery') {
    await fs.writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
    await fs.mkdir(lock + '.recovery');
    await fs.utimes(lock + '.recovery', 0, 0);
  }
  await fs.utimes(lock, 0, 0);
  await recoverRepositoryCheck(repo);
  expect((await runCheck(repo, 'CHECK-1', 'build')).exitCode).toBe(0);
});
it('preserves fresh ownerless locks during the acquisition grace period', async () => {
  await configure('process.exit(0)');
  const lock = join(repo, '.specflow/repository-check.lock');
  await fs.mkdir(lock);
  await recoverRepositoryCheck(repo);
  await expect(runCheck(repo, 'CHECK-1', 'build')).rejects.toThrow(/repository.*check/i);
});

async function setGeneratedPaths(paths: string[]) {
  const path = join(repo, '.specflow/checks.json');
  const config = JSON.parse(await fs.readFile(path, 'utf8'));
  config.generatedPaths = paths;
  await fs.writeFile(path, JSON.stringify(config));
}

it('accepts Maven regeneration of explicitly configured module outputs', async () => {
  await configure(`
    const fs = require('fs');
    for (const path of ['srv/target/classes', 'srv/src/gen/java', 'srv/src/main/resources/edmx', 'coverage']) fs.mkdirSync(path, {recursive:true});
    for (const path of ['srv/target/classes/Service.class', 'srv/src/gen/java/Service.java', 'srv/src/main/resources/edmx/service.xml', 'srv/src/main/resources/schema.sql', 'srv/.flattened-pom.xml']) fs.writeFileSync(path, 'regenerated');
    fs.writeFileSync('coverage/coverage-summary.json', JSON.stringify({total:{lines:{pct:90,total:100,covered:90}}}));
  `, true);
  await setGeneratedPaths(['srv/target', 'srv/src/gen', 'srv/src/main/resources/edmx', 'srv/src/main/resources/schema.sql', 'srv/.flattened-pom.xml']);
  const result = await runCheck(repo, 'CHECK-1', 'test');
  expect(result.exitCode).toBe(0);
  expect(result.codeChanged).toBe(false);
  expect(() => assertEvidence(result, 'test', result.codeFingerprint)).not.toThrow();
  expect(result.codeFingerprint).toBe(await fingerprint(repo));
});

it('keeps source, test, build configuration and published contracts in the fingerprint', async () => {
  await configure('process.exit(0)');
  await setGeneratedPaths(['srv/target', 'srv/src/gen']);
  for (const path of ['srv/src/main/java/Service.java', 'srv/src/test/java/ServiceTest.java', 'srv/pom.xml', 'srv/src/target/source.java', 'srv/target-extra/source.java', 'srv/src/main/resources/swagger/service.json']) {
    await fs.mkdir(join(repo, path, '..'), { recursive: true });
    const before = await fingerprint(repo);
    await fs.writeFile(join(repo, path), 'changed');
    expect(await fingerprint(repo)).not.toBe(before);
  }
});

it('invalidates successful evidence when the generation exclusion policy changes', async () => {
  await configure('process.exit(0)');
  await setGeneratedPaths(['srv/target']);
  const result = await runCheck(repo, 'CHECK-1', 'build');
  await setGeneratedPaths(['srv/target', 'srv/src/gen']);
  expect(() => assertEvidence(result, 'build', result.codeFingerprint)).not.toThrow();
  const current = await fingerprint(repo);
  expect(current).not.toBe(result.codeFingerprint);
  expect(() => assertEvidence(result, 'build', current)).toThrow(/changed/i);
});

it('marks exclusion-policy changes made by the check itself as code changes', async () => {
  await configure(`const fs=require('fs');const p='.specflow/checks.json';const c=JSON.parse(fs.readFileSync(p));c.generatedPaths=['srv/target'];fs.writeFileSync(p,JSON.stringify(c));`);
  expect((await runCheck(repo, 'CHECK-1', 'build')).codeChanged).toBe(true);
});

it.each(['.', '..', '../outside', '/tmp/output', 'srv/../src', 'srv/**', 'srv/target/', 'srv\\target'])('rejects invalid generated output path %s before running commands', async (path) => {
  await configure(`require('fs').writeFileSync('launched','yes')`);
  await setGeneratedPaths([path]);
  await expect(runCheck(repo, 'CHECK-1', 'build')).rejects.toThrow(/generatedPaths/i);
  expect(await fs.stat(join(repo, 'launched')).catch(() => null)).toBeNull();
});
