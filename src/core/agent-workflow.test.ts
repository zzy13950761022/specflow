import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AppCore } from './app-core.js';

let root: string, app: AppCore, repoId: string;
const oldHome = process.env.AI_PILOT_HOME;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'agent-flow-')); process.env.AI_PILOT_HOME = join(root, 'home'); app = new AppCore(); repoId = (await app.addRepo(root)).id; });
afterEach(async () => { if (oldHome === undefined) delete process.env.AI_PILOT_HOME; else process.env.AI_PILOT_HOME = oldHome; await fs.rm(root, { recursive: true, force: true }); });
it('snapshots the selected profile at creation and includes the brief in stage prompts', async () => {
  await app.agentSettings.save({ revision: 0, profiles: [{ id: 'p', name: 'Personal', agent: 'claude', version: 1, model: 'my-model' }], defaultProfileId: 'p' });
  const spec = await app.createSpec(repoId, 'T-1', 'Feature', { autoRun: true, agentProfileId: 'p', description: 'Support the desired customer workflow.' });
  expect(spec.automation?.profile?.agent).toBe('claude');
  expect(spec.description).toContain('customer');
  expect((await app.getStagePrompt(repoId, 'T-1', 'spec')).content).toContain('Support the desired customer workflow.');
});
it('copy is read-only and handoff preserves work while fencing stale managed output', async () => {
  await app.createSpec(repoId, 'T-1', 'Feature', { autoRun: true });
  await app.updateAutomation(repoId, 'T-1', spec => { spec.automation!.threadId = 'native-session'; });
  const before = await app.getSpec(repoId, 'T-1');
  expect((await app.getHandoff(repoId, 'T-1')).context).toContain('/specflow T-1');
  expect(await app.getSpec(repoId, 'T-1')).toEqual(before);
  await app.handoffToIde(repoId, 'T-1');
  const after = (await app.getSpec(repoId, 'T-1'))!;
  expect(after.automation?.enabled).toBe(false);
  expect(after.automation?.mode).toBe('ide');
  expect(after.execution.status).toBe('ready');
  expect(() => app.assertAutomationRun(after, 'old-run')).toThrow();
  expect((await app.getHandoff(repoId, 'T-1')).context).toContain('Repository ID: ' + repoId);
});
it('does not hand off an active check or enable automation over an external task claim', async () => {
  await app.createSpec(repoId, 'T-1', 'Feature');
  await app.updateAutomation(repoId, 'T-1', spec => { spec.stages[0].activeCheck = { runId: 'check', pid: process.pid, revision: 0, startedAt: new Date().toISOString() }; });
  await expect(app.handoffToIde(repoId, 'T-1')).rejects.toThrow(/check/i);
  await app.updateAutomation(repoId, 'T-1', spec => { spec.stages[0].activeCheck = undefined; spec.stages[3].subtasks = [{ id: 'task', description: 'working', completed: false, status: 'running', claimId: 'external', attempt: 1, dependsOn: [], files: [], testRefs: [] }]; });
  await expect(app.resumeAutomation(repoId, 'T-1')).rejects.toThrow(/claim|task/i);
});
