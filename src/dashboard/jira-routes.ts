import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JiraIntegration, JiraTicketId } from '../integrations/jira.js';

export function registerJiraRoutes(server: FastifyInstance, jira = new JiraIntegration()) {
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
    catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });
}
