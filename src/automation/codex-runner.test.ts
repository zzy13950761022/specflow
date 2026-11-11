import { it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { AppCore } from '../core/app-core.js';
import { Orchestrator } from './orchestrator.js';
import { createCodexExecutor } from './codex-runner.js';

it('drives a ticket through plan and implementation reviews into real worktree checks', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'codex-workflow-')); const repo = join(root, 'repo');
  process.env.AI_PILOT_HOME = join(root, 'home'); process.env.PILOT_FIXTURE_MODE = 'workflow';
  await fs.mkdir(repo); execFileSync('git', ['init', '-q', repo]); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'Initial']);
  const command = join(root, 'codex-fixture');
  await fs.writeFile(command, '#!' + process.execPath + String.fromCharCode(10) + await fs.readFile(fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url)), 'utf8'), { mode: 0o700 });
  const app = new AppCore(); const id = (await app.addRepo(repo)).id;
  await fs.mkdir(join(repo, '.specflow'));
  await fs.writeFile(join(repo, '.specflow', 'checks.json'), JSON.stringify({ test: { command: process.execPath, args: ['-e', 'const fs=require("fs");if(!fs.existsSync("source.ts"))process.exit(1);fs.mkdirSync("coverage",{recursive:true});fs.writeFileSync("coverage/coverage-summary.json",JSON.stringify({total:{lines:{pct:90,total:10,covered:9}}}))'], coverageReport: 'coverage/coverage-summary.json' }, build: { command: process.execPath, args: ['-e', 'process.exit(0)'] } }));
  const configPath = join(root, 'config.toml');
  await fs.writeFile(configPath, 'model_provider = "local"\nmodel = "local-model"\n[model_providers.local]\nbase_url = "http://localhost:6655/v1"\nwire_api = "responses"\n[mcp_servers.forbidden]\ncommand = "forbidden"\n');
  const service = new Orchestrator(app, createCodexExecutor(app, command, join(root, 'no-auth.json'), configPath));
  const wait = async (check: () => Promise<boolean>) => { for (let i = 0; i < 300; i++) { if (await check()) return; const state = await app.getSpec(id, 'AUTO-1'); if (state?.automation?.status === 'failed') throw new Error(state.automation.error); await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('Timed out'); };
  try {
    await service.start(); await app.createSpec(id, 'AUTO-1', 'Feature', { workflowKind: 'bugfix', autoRun: true });
    await wait(async () => (await app.getSpec(id, 'AUTO-1'))?.automation?.status === 'waiting_review');
    const runtimeConfig = await fs.readFile(join(root, 'home/runners', id, 'AUTO-1/config.toml'), 'utf8');
    expect(runtimeConfig).toContain('http://localhost:6655/v1'); expect(runtimeConfig).not.toContain('mcp_servers');
    await app.approve(id, 'AUTO-1', 'spec', 1);
    await wait(async () => (await app.getSpec(id, 'AUTO-1'))?.stages[3].gate.status === 'pending_review');
    await app.approve(id, 'AUTO-1', 'develop', 1);
    await wait(async () => (await app.getSpec(id, 'AUTO-1'))?.stages[3].subtasks?.[0].review?.status === 'pending_review');
    const implemented = (await app.getSpec(id, 'AUTO-1'))!;
    expect(implemented.currentStageId).toBe('develop'); expect(implemented.automation?.threadId).toBe('thread-one');
    await expect(fs.stat(join(repo, 'source.ts'))).rejects.toThrow();
    await app.reviewImplementation(id, 'AUTO-1', 'A', implemented.stages[3].subtasks![0].review!.id, 'approved');
    await wait(async () => (await app.getSpec(id, 'AUTO-1'))?.stages[4].gate.status === 'pending_review');
    const checked = (await app.getSpec(id, 'AUTO-1'))!;
    expect(checked.stages[4].evidence?.exitCode).toBe(0); expect(checked.stages[4].evidence?.coverage).toBe(0.9);
  } finally { await service.stop(); delete process.env.AI_PILOT_HOME; delete process.env.PILOT_FIXTURE_MODE; await fs.rm(root, { recursive: true, force: true }); }
});
