import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppCore } from '../core/app-core.js';
import { StageIdSchema } from '../core/schemas.js';

type TicketParams = { repoId: string; ticketId: string };
export function registerWorkflowRoutes(server: FastifyInstance, app: AppCore, runnerEnabled = false): void {
  const prefix = '/api/repos/:repoId/specs/:ticketId';
  function post<T extends z.ZodTypeAny>(suffix: string, schema: T, run: (params: TicketParams, input: z.infer<T>) => Promise<unknown>) {
    server.post<{ Params: TicketParams; Body: unknown }>(prefix + suffix, async (req, reply) => {
      const input = schema.safeParse(req.body ?? {});
      if (!input.success) return reply.code(400).send({ error: input.error.message });
      try { return await run(req.params, input.data); }
      catch (error) { return reply.code(400).send({ error: String((error as Error).message) }); }
    });
  }
  post('/reopen', z.object({ stageId: StageIdSchema, reason: z.string().trim().min(1) }),
    (p, body) => app.reopenStage(p.repoId, p.ticketId, body.stageId, body.reason));
  post('/checks', z.object({ stageId: z.enum(['test', 'build']) }),
    (p, body) => app.runStageCheck(p.repoId, p.ticketId, body.stageId));
  post('/advance', z.object({ stageId: StageIdSchema }), (p, body) => app.advance(p.repoId, p.ticketId, body.stageId));
  post('/execution/pause', z.object({}), (p) => app.pauseExecution(p.repoId, p.ticketId));
  post('/execution/resume', z.object({}), (p) => app.resumeExecution(p.repoId, p.ticketId));
  post('/develop/claim', z.object({ subtaskId: z.string() }), (p, body) => app.claimSubtask(p.repoId, p.ticketId, body.subtaskId));
  post('/develop/release', z.object({ subtaskId: z.string(), claimId: z.string() }), (p, body) => app.releaseSubtask(p.repoId, p.ticketId, body.subtaskId, body.claimId));
  post('/develop/completed', z.object({ subtaskId: z.string(), completed: z.boolean(), claimId: z.string().optional() }),
    (p, body) => app.setSubtaskCompleted(p.repoId, p.ticketId, body.subtaskId, body.completed, body.claimId));
  post('/develop/submit-review', z.object({}), (p) => app.submitImplementationReview(p.repoId, p.ticketId));
  post('/develop/review', z.object({ subtaskId: z.string(), expectedReviewId: z.string(), verdict: z.enum(['approved', 'rejected', 'needs_revision']), comment: z.string().optional() }),
    (p, body) => app.reviewImplementation(p.repoId, p.ticketId, body.subtaskId, body.expectedReviewId, body.verdict, body.comment));
  server.get<{ Params: TicketParams; Querystring: { subtaskId: string } }>(prefix + '/develop/review', async (req, reply) => {
    try { return await app.getImplementationReview(req.params.repoId, req.params.ticketId, req.query.subtaskId); }
    catch (error) { return reply.code(400).send({ error: String((error as Error).message) }); }
  });
  post('/automation', z.object({ enabled: z.boolean(), profileId: z.string().optional() }), async (p, body) => {
    if (body.enabled && !runnerEnabled) throw new Error('Restart Dashboard without --no-runner before enabling automatic execution.');
    if (!body.enabled) { await app.handoffToIde(p.repoId, p.ticketId); return app.getSpec(p.repoId, p.ticketId); }
    const current = await app.getSpec(p.repoId, p.ticketId);
    const profile = body.enabled && (body.profileId || !current?.automation?.profile) ? await app.agentSettings.resolve(p.repoId, body.profileId) : undefined;
    return app.configureAutomation(p.repoId, p.ticketId, body.enabled, profile);
  });
  server.get<{ Params: TicketParams }>(prefix + '/handoff', async (request, reply) => {
    try { return await app.getHandoff(request.params.repoId, request.params.ticketId); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  post('/handoff', z.object({}), p => app.handoffToIde(p.repoId, p.ticketId));
  post('/automation/resume', z.object({ profileId: z.string().optional() }), (p, body) => {
    if (!runnerEnabled) throw new Error('Automatic execution is unavailable.');
    return app.resumeAutomation(p.repoId, p.ticketId, body.profileId);
  });
  post('/automation/retry', z.object({}), async (p) => {
    if (!runnerEnabled) throw new Error('Automatic execution is unavailable.');
    const spec = await app.getSpec(p.repoId, p.ticketId);
    if (spec?.automation?.status !== 'failed') throw new Error('Only failed automation runs can be retried.');
    await app.resumeExecution(p.repoId, p.ticketId);
    return app.configureAutomation(p.repoId, p.ticketId, true);
  });
  for (const suffix of ['/execution', '/traceability'] as const) {
    server.get<{ Params: TicketParams }>(prefix + suffix, async (req, reply) => {
      try { return suffix === '/execution' ? await app.getExecutionStatus(req.params.repoId, req.params.ticketId) : await app.getTraceability(req.params.repoId, req.params.ticketId); }
      catch (error) { return reply.code(400).send({ error: String((error as Error).message) }); }
    });
  }
  server.get<{ Params: TicketParams; Querystring: { stageId?: string } }>(prefix + '/context', async (req, reply) => {
    const stage = StageIdSchema.safeParse(req.query.stageId);
    if (!stage.success) return reply.code(400).send({ error: 'valid stageId required' });
    try { return await app.getStageContext(req.params.repoId, req.params.ticketId, stage.data); }
    catch (error) { return reply.code(400).send({ error: String((error as Error).message) }); }
  });
}
