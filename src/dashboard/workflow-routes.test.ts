import { it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppCore } from '../core/app-core.js';
import { buildDashboard } from './server.js';

it('REST validates artifact revisions and exposes rework and pause/resume', async () => {
  const home = await fs.mkdtemp(join(tmpdir(), 'routes-home-'));
  const repo = await fs.mkdtemp(join(tmpdir(), 'routes-repo-'));
  process.env.AI_PILOT_HOME = home;
  const app = new AppCore(); const { id } = await app.addRepo(repo); const server = await buildDashboard(app);
  try {
    const created = await server.inject({ method: 'POST', url: '/api/repos/' + id + '/specs', payload: { ticketId: 'REST-1', title: 'REST', workflowKind: 'bugfix' } });
    expect(created.json().workflow.workflowKind).toBe('bugfix');
    const url = '/api/repos/' + id + '/specs/REST-1';
    await app.recordAiOutput(id, 'REST-1', 'spec', 'Initial');
    expect((await server.inject({ method: 'POST', url: url + '/approve', payload: { stageId: 'spec', expectedRevision: 0 } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: url + '/approve', payload: { stageId: 'spec', expectedRevision: 1 } })).statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url: url + '/reopen', payload: { stageId: 'spec', reason: 'Changed contract' } })).json().stages[0].stale).toBe(true);
    await server.inject({ method: 'POST', url: url + '/execution/pause' });
    expect((await server.inject({ method: 'GET', url: url + '/execution' })).json().status).toBe('paused');
    await server.inject({ method: 'POST', url: url + '/execution/resume' });
    expect((await server.inject({ method: 'GET', url: url + '/execution' })).json().actions[0].tool).toBe('get_stage_prompt');
  } finally { await server.close(); delete process.env.AI_PILOT_HOME; await fs.rm(home, { recursive: true, force: true }); await fs.rm(repo, { recursive: true, force: true }); }
});
