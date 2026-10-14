import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { AppCore } from '../core/app-core.js';
import { buildDashboard, startDashboard } from './server.js';

let home: string;
let repo: string;
let app: AppCore;
let repoId: string;
let fastify: FastifyInstance;

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-home-'));
  repo = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-repo-'));
  process.env.AI_PILOT_HOME = home;
  app = new AppCore();
  repoId = (await app.addRepo(repo)).id;
  fastify = await buildDashboard(app);
});

afterEach(async () => {
  await fastify.close();
  delete process.env.AI_PILOT_HOME;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(repo, { recursive: true, force: true });
});

describe('Dashboard REST', () => {
  it('GET /api/health', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /api/repos lists registered repos', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/repos' });
    expect(res.json()).toHaveLength(1);
  });

  it('POST /api/repos/:repoId/specs creates a spec', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/specs`,
      payload: { ticketId: 'ABC-1', title: 'Checkout Tax' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ticketId).toBe('ABC-1');
  });

  it('POST create spec validates required fields', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/specs`,
      payload: { ticketId: 'ABC-1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('approve flips the gate to approved', async () => {
    await app.createSpec(repoId, 'ABC-1', 'x');
    await app.recordAiOutput(repoId, 'ABC-1', 'spec', '# body');
    const res = await fastify.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/specs/ABC-1/approve`,
      payload: { stageId: 'spec' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stages[0].gate.status).toBe('approved');
  });

  it('reject records a comment and routes back to in_progress', async () => {
    await app.createSpec(repoId, 'ABC-1', 'x');
    await app.recordAiOutput(repoId, 'ABC-1', 'spec', '# body');
    const res = await fastify.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/specs/ABC-1/reject`,
      payload: { stageId: 'spec', comment: 'needs detail' },
    });
    expect(res.json().stages[0].gate.status).toBe('rejected');
    expect(res.json().stages[0].gate.comment).toBe('needs detail');
  });

  it('approve rejects an invalid stageId', async () => {
    await app.createSpec(repoId, 'ABC-1', 'x');
    const res = await fastify.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/specs/ABC-1/approve`,
      payload: { stageId: 'not-a-stage' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /api/repos/:id removes from index only', async () => {
    const res = await fastify.inject({ method: 'DELETE', url: `/api/repos/${repoId}` });
    expect(res.json()).toEqual({ removed: true });
  });
});

describe('Dashboard WebSocket live fan-out', () => {
  it('pushes a spec.created event to connected browsers', async () => {
    const { fastify: live } = await startDashboard(app, { port: 0 });
    try {
      // port 0 picks a free port; read it back from the server address
      const addr = live.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const received: any[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      ws.on('message', (data) => received.push(JSON.parse(data.toString())));

      await app.createSpec(repoId, 'WS-1', 'live');
      // give the frame a tick to arrive
      await new Promise((r) => setTimeout(r, 100));
      ws.close();

      expect(received.some((e) => e.type === 'spec.created' && e.spec.ticketId === 'WS-1')).toBe(true);
    } finally {
      await live.close();
    }
  });
});
