import { randomBytes, timingSafeEqual } from 'crypto';
import type { FastifyInstance } from 'fastify';

/** Browser review capability; managed Codex runs cannot access the network. */
export function registerReviewSession(server: FastifyInstance): void {
  const token = randomBytes(32).toString('hex');
  server.get('/api/review-session', async (req, reply) => {
    if (req.headers['sec-fetch-site'] !== 'same-origin') return reply.code(403).send({ error: 'Open Dashboard in your browser to review.' });
    reply.header('cache-control', 'no-store'); return { token };
  });
  server.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const path = req.routeOptions.url ?? req.url.split('?')[0];
    const decision = /[/](approve|reject|needs-revision)$/.test(path) || path.endsWith('/develop/review') || path.includes('/automation');
    const managedCreation = path.endsWith('/specs') && (req.body as { autoRun?: boolean } | null)?.autoRun;
    if (!decision && !managedCreation) return;
    const origin = req.headers.origin;
    if (origin && origin !== 'http://' + req.headers.host && origin !== 'https://' + req.headers.host) return reply.code(403).send({ error: 'Review must originate from this Dashboard.' });
    const provided = req.headers['x-specflow-review-session'];
    if (typeof provided !== 'string' || provided.length !== token.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) return reply.code(403).send({ error: 'Dashboard review session required. Reload Dashboard and retry.' });
  });
}
