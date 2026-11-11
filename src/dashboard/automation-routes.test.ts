import { it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppCore } from '../core/app-core.js';
import { buildDashboard } from '../test-support/dashboard-session.js';
import { prepareStage } from '../test-support/workflow-fixtures.js';

it('retry recovers a dead platform check before requeueing the ticket', async () => {
  const repo = await fs.mkdtemp(join(tmpdir(), 'automation-retry-')); process.env.AI_PILOT_HOME = join(repo, '.specflow', 'registry');
  const app = new AppCore(); const id = (await app.addRepo(repo)).id;
  await app.createSpec(id, 'RETRY-1', 'Feature'); await prepareStage(app, repo, id, 'RETRY-1', 'test');
  await app.updateAutomation(id, 'RETRY-1', (spec) => { spec.automation = { enabled: true, status: 'failed', attempt: 1, ownerPid: 2147483000 }; spec.stages[4].activeCheck = { runId: 'dead-check', pid: 2147483000, revision: 0 }; });
  const lock = join(repo, '.specflow', 'repository-check.lock'); await fs.mkdir(lock); await fs.writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483000, runId: 'dead-check' }));
  const server = await buildDashboard(app, { runnerEnabled: true });
  try {
    const result = await server.inject({ method: 'POST', url: '/api/repos/' + id + '/specs/RETRY-1/automation/retry', payload: {} });
    expect(result.statusCode).toBe(200); expect(result.json().stages[4].activeCheck).toBeUndefined(); expect(result.json().automation.status).toBe('queued');
    await expect(fs.stat(lock)).rejects.toThrow();
  } finally { await server.close(); delete process.env.AI_PILOT_HOME; await fs.rm(repo, { recursive: true, force: true }); }
});
it('retry refuses a retained live check lock even without matching activeCheck metadata', async () => {
  const repo = await fs.mkdtemp(join(tmpdir(), 'automation-live-check-')); process.env.AI_PILOT_HOME = join(repo, '.specflow', 'registry');
  const app = new AppCore(); const id = (await app.addRepo(repo)).id;
  await app.createSpec(id, 'RETRY-2', 'Feature');
  await app.updateAutomation(id, 'RETRY-2', (spec) => { spec.automation = { enabled: true, status: 'failed', attempt: 1 }; });
  const lock = join(repo, '.specflow', 'repository-check.lock'); await fs.mkdir(lock); await fs.writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, runId: 'live-check' }));
  const server = await buildDashboard(app, { runnerEnabled: true });
  try {
    const result = await server.inject({ method: 'POST', url: '/api/repos/' + id + '/specs/RETRY-2/automation/retry', payload: {} });
    expect(result.statusCode).toBe(400); expect((await app.getSpec(id, 'RETRY-2'))!.automation!.status).toBe('failed');
    expect(await fs.stat(lock)).toBeTruthy();
  } finally { await server.close(); delete process.env.AI_PILOT_HOME; await fs.rm(repo, { recursive: true, force: true }); }
});
