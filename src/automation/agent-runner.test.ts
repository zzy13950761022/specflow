import { expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { AppCore } from '../core/app-core.js';
import { Orchestrator } from './orchestrator.js';
import { createCodexExecutor } from './codex-runner.js';

for (const agent of ['claude', 'opencode'] as const) it(agent + ' creates, revises and implements using persisted sessions and human gates', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'agent-workflow-'));
  const oldHome = process.env.AI_PILOT_HOME; process.env.AI_PILOT_HOME = join(root, 'home');
  const repo = join(root, 'repo'); await fs.mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  await fs.mkdir(join(repo, '.codex')); await fs.writeFile(join(repo, '.codex', 'config.toml'), '[mcp_servers.ide_only]' + String.fromCharCode(10) + 'command="not-started"');
  execFileSync('git', ['-C', repo, 'add', '.codex/config.toml']); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'Initial']);
  const command = join(root, 'native-agent');
  const code = [
    'let prompt=""; process.stdin.on("data", chunk => prompt += chunk);',
    'process.stdin.on("end", () => {',
    'let result={ content:"Generated artifact",subtasks:[],acceptanceCriteria:[],logsSanitized:true,checklistItems:[] };',
    'if(prompt.includes("; stage: spec;")) result.acceptanceCriteria=[{id:"AC-1",given:"a repo",when:"implemented",then:"source exists"}];',
    'if(prompt.includes("; stage: develop;")) result.subtasks=[{id:"A",description:"Implement source",dependsOn:[],files:["source.ts"],requirementRef:"AC-1",testRefs:[]}];',
    'if(prompt.includes("Implement this claimed task:")) result={summary:"Implemented AC-1",files:[{path:"source.ts",content:"export const feature = true;"}]};',
    'if(process.argv.includes("--print")) console.log(JSON.stringify({type:"result",subtype:"success",session_id:"native-session",structured_output:result}));',
    'else { console.log(JSON.stringify({type:"text",sessionID:"native-session",part:{text:JSON.stringify(result)}})); console.log(JSON.stringify({type:"step_finish",sessionID:"native-session",part:{reason:"stop"}})); }',
    '});',
  ].join(String.fromCharCode(10));
  await fs.writeFile(command, '#!' + process.execPath + String.fromCharCode(10) + code, { mode: 0o700 });
  const configPath = join(root, 'native.json'); await fs.writeFile(configPath, '{}');
  const app = new AppCore(); const id = (await app.addRepo(repo)).id;
  await app.agentSettings.save({ revision: 0, profiles: [{ id: 'p', name: 'Test', agent, command, configPath, model: agent === 'opencode' ? 'hyperspace/test' : 'test' }], defaultProfileId: 'p', repoDefaults: {} });
  const service = new Orchestrator(app, createCodexExecutor(app));
  const wait = async (predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 300; i++) { if (await predicate()) return; const state = await app.getSpec(id, 'N-1'); if (state?.automation?.status === 'failed') throw new Error(state.automation.error); await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Timed out');
  };
  try {
    await service.start();
    await app.createSpec(id, 'N-1', 'Feature', { autoRun: true, agentProfileId: 'p', workflowKind: 'bugfix' });
    await wait(async () => (await app.getSpec(id, 'N-1'))?.automation?.status === 'waiting_review');
    await app.requestRevision(id, 'N-1', 'spec', 'Clarify acceptance', 1);
    await wait(async () => (await app.getSpec(id, 'N-1'))?.stages[0].revision === 2 && (await app.getSpec(id, 'N-1'))?.automation?.status === 'waiting_review');
    await app.approve(id, 'N-1', 'spec', 2);
    await wait(async () => (await app.getSpec(id, 'N-1'))?.stages[3].gate.status === 'pending_review');
    await app.approve(id, 'N-1', 'develop', 1);
    await wait(async () => (await app.getSpec(id, 'N-1'))?.stages[3].subtasks?.[0].review?.status === 'pending_review');
    const spec = (await app.getSpec(id, 'N-1'))!;
    expect(spec.automation?.profile?.agent).toBe(agent);
    expect(spec.automation?.threadId).toBe('native-session');
    expect(spec.currentStageId).toBe('develop');
    expect(await fs.readFile(join(spec.automation!.worktreePath!, 'source.ts'), 'utf8')).toContain('feature = true');
    await expect(fs.stat(join(repo, 'source.ts'))).rejects.toThrow();
    await app.handoffToIde(id, 'N-1');
    expect((await app.getSpec(id, 'N-1'))?.automation?.mode).toBe('ide');
  } finally { await service.stop(); if (oldHome === undefined) delete process.env.AI_PILOT_HOME; else process.env.AI_PILOT_HOME = oldHome; await fs.rm(root, { recursive: true, force: true }); }
});
