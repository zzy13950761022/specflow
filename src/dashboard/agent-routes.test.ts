import { expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppCore } from '../core/app-core.js';
import { buildDashboard } from './server.js';
import Fastify from 'fastify';
import { registerAgentRoutes } from './agent-routes.js';
import * as detection from '../automation/agent-detection.js';
import * as adapters from '../automation/agent-adapters.js';

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
    const command = join(root, 'claude'); await fs.writeFile(command, '#!/bin/sh\necho claude-test\n', { mode: 0o755 });
    const settings = { revision: 0, profiles: [{ id: 'p', name: 'My Claude', agent: 'claude', version: 1, model: 'hyperspace-model', configPath, command }], defaultProfileId: 'p' };
    expect((await server.inject({ method: 'PUT', url: '/api/agents/settings', headers, payload: settings })).statusCode).toBe(200);
    const created = await server.inject({ method: 'POST', url: '/api/repos/' + repo.id + '/specs', headers, payload: { ticketId: 'A-1', title: 'Feature', description: 'Acceptance context', autoRun: true } });
    expect(created.statusCode).toBe(200);
    expect(created.json().automation.profile.model).toBe('hyperspace-model');
    const handoff = await server.inject({ method: 'GET', url: '/api/repos/' + repo.id + '/specs/A-1/handoff', headers });
    expect(handoff.json().context).toContain('/specflow A-1');
    expect((await server.inject({ method: 'PUT', url: '/api/agents/settings', headers, payload: settings })).statusCode).toBe(400);
  } finally { await server.close(); if (oldHome === undefined) delete process.env.AI_PILOT_HOME; else process.env.AI_PILOT_HOME = oldHome; await fs.rm(root, { recursive: true, force: true }); }
});

it('uses the discovered executable for connection tests', async () => {
  const server = Fastify();
  registerAgentRoutes(server, {} as AppCore);
  const detect = vi.spyOn(detection, 'detectAgent').mockResolvedValue({ available: true, command: '/test/resolved/claude', version: 'test', models: [] });
  const run = vi.spyOn(adapters, 'runAgentTurn').mockResolvedValue({ text: '{"ok":true}' } as Awaited<ReturnType<typeof adapters.runAgentTurn>>);
  try {
    const response = await server.inject({ method: 'POST', url: '/api/agents/test', payload: { profile: { id: 'p', name: 'P', agent: 'claude', version: 1 } } });
    expect(response.json().ok).toBe(true);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.objectContaining({ command: '/test/resolved/claude' }) }));
  } finally { detect.mockRestore(); run.mockRestore(); await server.close(); }
});
it('detect API exposes only local model choices and installation metadata', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'agents-detect-api-'));
  const server = Fastify(); registerAgentRoutes(server, {} as AppCore);
  try {
    const command = join(root, 'claude'); await fs.writeFile(command, '#!/bin/sh\necho claude-test\n', { mode: 0o755 });
    const configPath = join(root, 'native.json'); await fs.writeFile(configPath, JSON.stringify({ model: 'current', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'configured', ANTHROPIC_AUTH_TOKEN: 'never-return-secret' } }));
    const response = await server.inject({ method: 'POST', url: '/api/agents/detect', payload: { agent: 'claude', command, configPath } });
    expect(response.json()).toMatchObject({ available: true, command, installations: [{ command, version: 'claude-test' }], models: [{ id: 'current' }, { id: 'configured' }] });
    expect(response.body).not.toContain('never-return-secret');
    expect(response.json()).not.toHaveProperty('env');
  } finally { await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});
