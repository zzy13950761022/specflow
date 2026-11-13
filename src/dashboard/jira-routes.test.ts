import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerReviewSession } from './review-session.js';
import { registerJiraRoutes } from './jira-routes.js';
import { JiraIntegration } from '../integrations/jira.js';

it('protects Jira configuration and lookups with a browser session and rejects command injection', async () => {
  const server = Fastify(); const jira = new JiraIntegration('/missing');
  const issue = vi.spyOn(jira, 'issue').mockResolvedValue({ key: 'TEST-1', summary: 'Summary', description: 'Requirements' });
  registerReviewSession(server); registerJiraRoutes(server, jira);
  try {
    expect((await server.inject({ url: '/api/integrations/jira' })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/api/integrations/jira/issue', payload: { ticketId: 'TEST-1' } })).statusCode).toBe(403);
    const session = await server.inject({ url: '/api/review-session', headers: { 'sec-fetch-site': 'same-origin' } });
    const headers = { 'x-specflow-review-session': session.json().token };
    expect((await server.inject({ method: 'POST', url: '/api/integrations/jira/issue', headers, payload: { ticketId: 'TEST-1', command: 'arbitrary' } })).statusCode).toBe(400);
    expect(issue).not.toHaveBeenCalled();
    const response = await server.inject({ method: 'POST', url: '/api/integrations/jira/issue', headers, payload: { ticketId: 'test-1' } });
    expect(response.json()).toEqual({ key: 'TEST-1', summary: 'Summary', description: 'Requirements' });
    expect(issue).toHaveBeenCalledWith('TEST-1');
  } finally { await server.close(); }
});
