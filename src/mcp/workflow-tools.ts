import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AppCore } from '../core/app-core.js';
import { StageIdSchema } from '../core/schemas.js';

async function respond(promise: Promise<unknown>) {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(await promise, null, 2) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: String((error as Error).message) }) }] }; }
}

export function registerWorkflowTools(server: McpServer, app: AppCore): void {
  const ticket = { repoId: z.string(), ticketId: z.string() };
  const task = { ...ticket, subtaskId: z.string() };
  server.registerTool('submit_implementation_review', { description: 'Submit immutable implementation reports for completed subtasks. Human approval in Dashboard is required before TEST.', inputSchema: ticket },
    async ({ repoId, ticketId }) => respond(app.submitImplementationReview(repoId, ticketId)));
  server.registerTool('get_implementation_review', { description: 'Read an implementation report and its review status. This read never grants approval.', inputSchema: task },
    async ({ repoId, ticketId, subtaskId }) => respond(app.getImplementationReview(repoId, ticketId, subtaskId)));
  server.registerTool('reopen_stage', {
    description: 'Reopen a reached stage with a reason. Invalidates affected downstream approvals, artifacts, task completion and verification evidence while preserving history.',
    inputSchema: { ...ticket, stageId: StageIdSchema, reason: z.string().trim().min(1) },
  }, async ({ repoId, ticketId, stageId, reason }) => respond(app.reopenStage(repoId, ticketId, stageId, reason)));
  server.registerTool('run_stage_check', {
    description: 'Execute the configured test/build argv in .specflow/checks.json and persist authoritative output, exit code, source fingerprint and actual coverage. Never replace this evidence with AI metrics.',
    inputSchema: { ...ticket, stageId: z.enum(['test', 'build']) },
  }, async ({ repoId, ticketId, stageId }) => respond(app.runStageCheck(repoId, ticketId, stageId)));
  server.registerTool('get_stage_context', {
    description: 'Read approved, current upstream artifacts, acceptance criteria and valid implementation logs for a stage. Missing or stale required inputs are errors.',
    inputSchema: { ...ticket, stageId: StageIdSchema },
  }, async ({ repoId, ticketId, stageId }) => respond(app.getStageContext(repoId, ticketId, stageId)));
  server.registerTool('get_traceability', { description: 'Map acceptance criteria to tasks, implemented files and test references, including missing links.', inputSchema: ticket },
    async ({ repoId, ticketId }) => respond(app.getTraceability(repoId, ticketId)));
  server.registerTool('get_execution_status', { description: 'Read persisted execution state and structured next actions; use this to resume a session without duplicating successful work.', inputSchema: ticket },
    async ({ repoId, ticketId }) => respond(app.getExecutionStatus(repoId, ticketId)));
  server.registerTool('get_next_actions', { description: 'Get executable next actions, including ready tasks and revision/check requirements. Completed or paused workflows have no actions.', inputSchema: ticket },
    async ({ repoId, ticketId }) => respond(app.getExecutionStatus(repoId, ticketId).then((status) => status.actions)));
  server.registerTool('pause_execution', { description: 'Explicitly pause new execution. Reading and human review remain available.', inputSchema: ticket },
    async ({ repoId, ticketId }) => respond(app.pauseExecution(repoId, ticketId)));
  server.registerTool('resume_execution', { description: 'Resume paused execution or recover an interrupted check. Does not automatically rerun commands or repeat completed tasks.', inputSchema: ticket },
    async ({ repoId, ticketId }) => respond(app.resumeExecution(repoId, ticketId)));
  server.registerTool('claim_subtask', { description: 'Claim a ready development task. Requires approved plan, completed dependencies and no declared file conflicts. Use returned claimId for logging and completion.', inputSchema: task },
    async ({ repoId, ticketId, subtaskId }) => respond(app.claimSubtask(repoId, ticketId, subtaskId)));
  server.registerTool('release_subtask', { description: 'Release failed/abandoned claimed work using its claimId; resets dependent task completion and invalidates previous attempt logs.', inputSchema: { ...task, claimId: z.string() } },
    async ({ repoId, ticketId, subtaskId, claimId }) => respond(app.releaseSubtask(repoId, ticketId, subtaskId, claimId)));
  server.registerTool('set_subtask_completed', { description: 'Idempotently set completion. Requires current-revision and current-attempt implementation log, dependencies, and claimId for claimed work.', inputSchema: { ...task, completed: z.boolean(), claimId: z.string().optional() } },
    async ({ repoId, ticketId, subtaskId, completed, claimId }) => respond(app.setSubtaskCompleted(repoId, ticketId, subtaskId, completed, claimId)));
}
