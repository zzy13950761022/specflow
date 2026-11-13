import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JiraImportError, JiraIntegration, JiraTicketId } from '../integrations/jira.js';

export function registerJiraRoutes(server: FastifyInstance, jira = new JiraIntegration()) {
  server.post('/api/integrations/jira/authenticate', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!z.object({}).strict().safeParse(request.body).success) return reply.code(400).send({ error: 'Authentication does not accept connection parameters.' });
    try { return await jira.authenticate(); }
    catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });
  server.get('/api/integrations/jira', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    try { return await jira.status(); }
    catch (error) { return reply.code(503).send({ error: (error as Error).message }); }
  });
  server.post('/api/integrations/jira/issue', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const input = z.object({ ticketId: JiraTicketId }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Enter a Jira Ticket ID such as PROJECT-123.' });
    try { return await jira.issue(input.data.ticketId); }
    catch (error) { return reply.code(502).send({ error: (error as Error).message, ...(error instanceof JiraImportError && error.code ? { code: error.code } : {}) }); }
  });
}
