import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { AppCore } from '../core/app-core.js';
import { StageIdSchema } from '../core/schemas.js';
import { logger } from '../core/logger.js';
import type { WebSocket } from 'ws';

/**
 * The dashboard HTTP+WS server. The human lives here: they Approve/Reject
 * gates. Binds 127.0.0.1 only. NEVER writes to stdout (Invariant #1) — Fastify
 * is configured with logging off and we use the stderr logger.
 *
 * Isolation (risk: an HTTP crash must not kill the MCP loop): callers wrap
 * start() in try/catch; route handlers never throw into the process.
 */
export interface DashboardOptions {
  port?: number;
  host?: string;
}

export async function buildDashboard(app: AppCore): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  await fastify.register(fastifyWebsocket);

  const sockets = new Set<WebSocket>();

  // Fan EventBus mutations out to every connected browser (Invariant #2).
  app.events.subscribe((event) => {
    const frame = JSON.stringify(event);
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {
        /* a dead socket is cleaned up on close */
      }
    }
  });

  fastify.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  fastify.get('/api/health', async () => ({ ok: true }));

  /* ---- repos ---- */
  fastify.get('/api/repos', async () => app.listRepos());

  fastify.post<{ Body: { path?: string } }>('/api/repos', async (req, reply) => {
    const path = req.body?.path;
    if (!path) return reply.code(400).send({ error: 'path is required' });
    try {
      return await app.addRepo(path);
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message) });
    }
  });

  fastify.delete<{ Params: { id: string } }>('/api/repos/:id', async (req, reply) => {
    const removed = await app.removeRepo(req.params.id);
    if (!removed) return reply.code(404).send({ error: 'repo not found' });
    return { removed: true };
  });

  /* ---- specs ---- */
  fastify.get<{ Params: { repoId: string } }>('/api/repos/:repoId/specs', async (req, reply) => {
    try {
      return await app.listSpecs(req.params.repoId);
    } catch (e) {
      return reply.code(404).send({ error: String((e as Error).message) });
    }
  });

  fastify.get<{ Params: { repoId: string; ticketId: string } }>(
    '/api/repos/:repoId/specs/:ticketId',
    async (req, reply) => {
      const spec = await app.getSpec(req.params.repoId, req.params.ticketId).catch(() => null);
      if (!spec) return reply.code(404).send({ error: 'spec not found' });
      return spec;
    }
  );

  fastify.post<{ Params: { repoId: string }; Body: { ticketId?: string; title?: string } }>(
    '/api/repos/:repoId/specs',
    async (req, reply) => {
      const { ticketId, title } = req.body ?? {};
      if (!ticketId || !title) {
        return reply.code(400).send({ error: 'ticketId and title are required' });
      }
      try {
        return await app.createSpec(req.params.repoId, ticketId, title);
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message) });
      }
    }
  );

  /* ---- gates: the human actions ---- */
  fastify.post<{
    Params: { repoId: string; ticketId: string };
    Body: { stageId?: string };
  }>('/api/repos/:repoId/specs/:ticketId/approve', async (req, reply) => {
    const stage = StageIdSchema.safeParse(req.body?.stageId);
    if (!stage.success) return reply.code(400).send({ error: 'valid stageId required' });
    try {
      return await app.approve(req.params.repoId, req.params.ticketId, stage.data);
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message) });
    }
  });

  fastify.post<{
    Params: { repoId: string; ticketId: string };
    Body: { stageId?: string; comment?: string };
  }>('/api/repos/:repoId/specs/:ticketId/reject', async (req, reply) => {
    const stage = StageIdSchema.safeParse(req.body?.stageId);
    if (!stage.success) return reply.code(400).send({ error: 'valid stageId required' });
    try {
      return await app.reject(
        req.params.repoId,
        req.params.ticketId,
        stage.data,
        req.body?.comment ?? ''
      );
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message) });
    }
  });

  // Serve the built SPA when present (production). The dashboard dist is copied
  // next to the compiled backend; in dev the Vite server proxies instead.
  const spaDir = join(dirname(fileURLToPath(import.meta.url)), 'public');
  if (existsSync(spaDir)) {
    await fastify.register(fastifyStatic, { root: spaDir });
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return fastify;
}

export async function startDashboard(
  app: AppCore,
  options: DashboardOptions = {}
): Promise<{ fastify: FastifyInstance; url: string }> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4123;
  const fastify = await buildDashboard(app);
  await fastify.listen({ host, port });
  const url = `http://${host}:${port}`;
  logger.info(`Dashboard listening at ${url}`);
  return { fastify, url };
}
