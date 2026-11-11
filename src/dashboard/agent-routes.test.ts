import { expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppCore } from '../core/app-core.js';
import { buildDashboard } from './server.js';

it('requires a browser session for settings and snapshots selected profiles on create', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'agents-api-')); const oldHome = process.env.AI_PILOT_HOME;
  process.env.AI_PILOT_HOME = join(root, 'home');
  const app = new AppCore(); const server = await buildDashboard(app, { runnerEnabled: true });
  try {
    const repo = await app.addRepo(root);
    expect((await server.inject({ method: 'GET', url: '/api/agents/settings' })).statusCode).toBe(403);
    const session = await server.inject({ method: 'GET', url: '/api/review-session', headers: { 'sec-fetch-site': 'same-origin' } });
    const headers = { 'x-specflow-review-session': session.json().token };
    const configPath = join(root, 'native.json'); await fs.writeFile(configPath, '{}');
    const settings = { revision: 0, profiles: [{ id: 'p', name: 'My Claude', agent: 'claude', version: 1, model: 'hyperspace-model', configPath }], defaultProfileId: 'p', repoDefaults: {} };
    expect((await server.inject({ method: 'PUT', url: '/api/agents/settings', headers, payload: settings })).statusCode).toBe(200);
    const created = await server.inject({ method: 'POST', url: '/api/repos/' + repo.id + '/specs', headers, payload: { ticketId: 'A-1', title: 'Feature', description: 'Acceptance context', autoRun: true } });
    expect(created.statusCode).toBe(200);
    expect(created.json().automation.profile.model).toBe('hyperspace-model');
    const handoff = await server.inject({ method: 'GET', url: '/api/repos/' + repo.id + '/specs/A-1/handoff', headers });
    expect(handoff.json().context).toContain('/specflow A-1');
    expect((await server.inject({ method: 'PUT', url: '/api/agents/settings', headers, payload: settings })).statusCode).toBe(400);
  } finally { await server.close(); if (oldHome === undefined) delete process.env.AI_PILOT_HOME; else process.env.AI_PILOT_HOME = oldHome; await fs.rm(root, { recursive: true, force: true }); }
});
