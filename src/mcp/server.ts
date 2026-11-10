import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AppCore } from '../core/app-core.js';
import { StageIdSchema, ImplArtifactsSchema, RequirementsDataSchema, WorkflowOptionsSchema, SpecFileSchema, SubtaskInputSchema, type ArtifactInput } from '../core/schemas.js';
import { GateNotApprovedError } from '../core/stage-machine.js';
import { logger } from '../core/logger.js';
import { registerWorkflowTools } from './workflow-tools.js';
import { completionAction } from '../core/execution.js';

/**
 * Thin MCP transport. Every handler delegates to AppCore and never embeds
 * gating logic. All SDK usage is isolated to this file (risk mitigation: SDK
 * drift). The returned content is text/JSON — AppCore owns the real state.
 */

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string, code?: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, code }, null, 2) }],
    isError: true,
  };
}

export function buildMcpServer(app: AppCore): McpServer {
  const server = new McpServer({ name: 'ai-pilot', version: '0.1.0' });
  registerWorkflowTools(server, app);

  server.registerTool(
    'list_repos',
    { description: 'List repositories registered with AI Pilot.', inputSchema: {} },
    async () => ok(await app.listRepos())
  );

  server.registerTool(
    'list_specs',
    {
      description: 'List all specs (8-stage tickets) in a repo.',
      inputSchema: { repoId: z.string() },
    },
    async ({ repoId }) => {
      try {
        return ok(await app.listSpecs(repoId));
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'get_spec',
    {
      description: 'Get one spec with its full 8-stage state machine and gate history.',
      inputSchema: { repoId: z.string(), ticketId: z.string() },
    },
    async ({ repoId, ticketId }) => {
      try {
        const spec = await app.getSpec(repoId, ticketId);
        return spec ? ok(spec) : fail(`Unknown spec: ${ticketId}`);
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'create_spec',
    {
      description:
        'Create a ticket with a standard, bugfix or documentation workflow template. Derives specPath from the title. ' +
        'Then proceed directly to get_stage_prompt — repo-specific prompt templates are ' +
        'NOT auto-generated. The templateStatus field reports whether this repo has ' +
        'user-provided templates ("ready") or will fall back to the built-in blueprint ' +
        'defaults ("none"); either way get_stage_prompt resolves the right prompt. ' +
        'Creating repo templates is optional and user-driven (see propose_repo_templates / ' +
        'write_repo_template, or add .specflow/templates/{stage}.md by hand).',
      inputSchema: { repoId: z.string(), ticketId: z.string().min(1), title: z.string().min(1), ...WorkflowOptionsSchema.shape },
    },
    async ({ repoId, ticketId, title, ...options }) => {
      try {
        const spec = await app.createSpec(repoId, ticketId, title, options);
        const templates = await app.listTemplates(repoId);
        const hasRepoTemplates = templates.some(
          (t) => t.source === 'repo-curated' || t.source === 'repo-draft'
        );
        const templateStatus = hasRepoTemplates ? 'ready' : 'none';
        const nextSteps = hasRepoTemplates
          ? ['Repo templates exist. Proceed to get_stage_prompt for the spec stage.']
          : [
              'No repo-specific templates found — get_stage_prompt will use the built-in ' +
              'blueprint defaults. Proceed directly to get_stage_prompt for the spec stage. ' +
              '(Optional: a user may add repo templates manually via propose_repo_templates / ' +
              'write_repo_template or by creating .specflow/templates/{stage}.md.)',
            ];
        return ok({ spec, templateStatus, nextSteps });
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'get_stage_prompt',
    {
      description:
        'Render the SAP prompt for a stage (prefers the repo-curated template, ' +
        'falls back to the blueprint default) with upstream context interpolated.',
      inputSchema: { repoId: z.string(), ticketId: z.string(), stageId: StageIdSchema },
    },
    async ({ repoId, ticketId, stageId }) => {
      try {
        return ok(await app.getStagePrompt(repoId, ticketId, stageId));
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'propose_repo_templates',
    {
      description:
        'Gather repo signals (AGENTS.md (or legacy CLAUDE.md), build files, test framework, sample source file; prefer agentsMd over legacy claudeMd) ' +
        'and return a generation brief. Use the brief to draft curated 8-stage templates ' +
        'for this repo, then call write_repo_template for each stage.',
      inputSchema: { repoId: z.string() },
    },
    async ({ repoId }) => {
      try {
        return ok(await app.proposeRepoTemplates(repoId));
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'write_repo_template',
    {
      description:
        'Persist a curated prompt template for one stage of a repo. ' +
        'The template is stored as a draft until a human marks it curated in the dashboard.',
      inputSchema: { repoId: z.string(), stageId: StageIdSchema, content: z.string() },
    },
    async ({ repoId, stageId, content }) => {
      try {
        await app.writeRepoTemplate(repoId, stageId, content);
        return ok({ ok: true, repoId, stageId });
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'record_ai_output',
    {
      description:
        "Persist the AI assistant's artifact for a stage, mark the AI action done, and " +
        'flip the human gate to pending_review. ' +
        'For REQUIREMENTS stages, supply requirementsData (affectedFiles + reuse/buildFromScratch/dataMigration/integrations) to create a structured requirements artifact the dashboard renders as a tree-table + four-quadrant grid. ' +
        'For DEPLOY stages, supply checklistItems (and optionally rollbackCriteria) to create a structured deploy-checklist artifact. ' +
        'For OPS stages, supply logsSanitized (true/false) to create an ops-report artifact — the governance flag is surfaced in the dashboard. ' +
        'All other stages default to a markdown artifact.',
      inputSchema: {
        repoId: z.string(),
        ticketId: z.string(),
        stageId: StageIdSchema,
        content: z.string(),
        checklistItems: z
          .array(
            z.object({
              id: z.string().optional(),
              description: z.string().min(1),
              checked: z.boolean().default(false),
              governanceFlag: z.enum(['pci', 'gdpr', 'none']).default('none'),
            })
          )
          .optional(),
        rollbackCriteria: z.string().optional(),
        logsSanitized: z.boolean().optional(),
        rcaPath: z.string().optional(),
        runbookPath: z.string().optional(),
        metrics: z
          .object({
            stageCoverage: z.number().optional(),
            cycleTimeMs: z.number().optional(),
            buildSuccess: z.boolean().optional(),
          })
          .optional(),
        requirementsData: RequirementsDataSchema.optional(),
        acceptanceCriteria: SpecFileSchema.shape.acceptanceCriteria.optional(),
      },
    },
    async ({ repoId, ticketId, stageId, content, checklistItems, rollbackCriteria, logsSanitized, rcaPath, runbookPath, metrics, requirementsData, acceptanceCriteria }) => {
      try {
        let artifactInput: ArtifactInput | undefined;
        if (stageId === 'requirements' && requirementsData) {
          artifactInput = { kind: 'requirements', data: requirementsData };
        } else if (stageId === 'deploy' && checklistItems) {
          artifactInput = { kind: 'deploy-checklist', items: checklistItems, rollbackCriteria };
        } else if (stageId === 'ops') {
          artifactInput = { kind: 'ops-report', logsSanitized: logsSanitized ?? false, rcaPath, runbookPath, metrics };
        } else if (metrics) {
          artifactInput = { kind: 'markdown', metrics };
        }
        return ok(await app.recordAiOutput(repoId, ticketId, stageId, content, artifactInput, acceptanceCriteria));
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'get_approval_status',
    {
      description: 'Wait up to waitMs (default 30 seconds, max 60 seconds) for a decision. Use waitMs=0 for a snapshot. Act on structured actions: approved development plans need implementation; final OPS approval completes the workflow.',
      inputSchema: { repoId: z.string(), ticketId: z.string(), stageId: StageIdSchema, waitMs: z.number().int().min(0).max(60_000).default(30_000) },
    },
    async ({ repoId, ticketId, stageId, waitMs }, extra) => {
      try {
        const gate = await app.waitForApproval(repoId, ticketId, stageId, waitMs, extra.signal);
        const execution = await app.getExecutionStatus(repoId, ticketId);
        return ok({ stageId, gate, execution, actions: execution.actions, nextSteps: execution.actions.map((action) => action.tool + ': ' + action.reason) });
      } catch (error) { return fail(String((error as Error).message)); }
    }
  );

  server.registerTool(
    'advance_stage',
    {
      description:
        'Advance to the next stage. REFUSED unless the current gate is approved ' +
        '(error code GATE_NOT_APPROVED). Approval happens in the dashboard.',
      inputSchema: { repoId: z.string(), ticketId: z.string(), stageId: StageIdSchema },
    },
    async ({ repoId, ticketId, stageId }) => {
      try {
        return ok(await app.advance(repoId, ticketId, stageId));
      } catch (e) {
        if (e instanceof GateNotApprovedError) return fail(e.message, e.code);
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'request_revision',
    {
      description:
        'Third gate verdict: ask the AI assistant to revise the output without fully rejecting it. ' +
        'Sets gate to needs_revision and aiStatus to in_progress so the AI assistant can re-record. ' +
        'advance_stage is still refused until the gate is approved.',
      inputSchema: {
        repoId: z.string(),
        ticketId: z.string(),
        stageId: StageIdSchema,
        comment: z.string().min(1),
      },
    },
    async ({ repoId, ticketId, stageId, comment }) => {
      try {
        return ok(await app.requestRevision(repoId, ticketId, stageId, comment));
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'set_develop_subtasks',
    {
      description:
        'Replace the DEVELOP implementation plan with stable task IDs, descriptions, ' +
        'optional prompts, requirementRef, testRefs, dependsOn and repository-relative files. ' +
        'Changes invalidate plan approval; resubmit the plan before coding. Release running claims before replacing it.',
      inputSchema: {
        repoId: z.string(),
        ticketId: z.string(),
        subtasks: z.array(SubtaskInputSchema),
      },
    },
    async ({ repoId, ticketId, subtasks }) => {
      try {
        return ok(await app.setDevelopSubtasks(repoId, ticketId, subtasks));
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'toggle_subtask',
    {
      description:
        'Toggle a single DEVELOP subtask between completed and not-completed. ' +
        'aiStatus derives automatically: done only when all subtasks are checked.',
      inputSchema: { repoId: z.string(), ticketId: z.string(), subtaskId: z.string() },
    },
    async ({ repoId, ticketId, subtaskId }) => {
      try {
        return ok(await app.toggleSubtask(repoId, ticketId, subtaskId));
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'log_implementation',
    {
      description:
        'Record a subtask implementation after the code is written to disk. ' +
        'Record a current-revision and current-attempt log BEFORE set_subtask_completed. ' +
        'Claimed tasks require the current claimId. A task without a valid implementation log is NOT complete. ' +
        'The log feeds context to subsequent test/build stages so they know what was built. ' +
        'Document relevant apiEndpoints, components, functions, classes or integrations. ' +
        'File-only changes may use artifacts={} when filesModified or filesCreated is nonempty.',
      inputSchema: {
        repoId: z.string(),
        ticketId: z.string(),
        subtaskId: z.string(),
        summary: z.string().min(1),
        claimId: z.string().optional(),
        filesModified: z.array(z.string()),
        filesCreated: z.array(z.string()),
        statistics: z.object({
          linesAdded: z.number().int().min(0),
          linesRemoved: z.number().int().min(0),
        }),
        artifacts: ImplArtifactsSchema,
      },
    },
    async ({ repoId, ticketId, subtaskId, summary, filesModified, filesCreated, statistics, artifacts, claimId }) => {
      try {
        const log = await app.logImplementation(repoId, ticketId, subtaskId, {
          summary, filesModified, filesCreated, statistics, artifacts, claimId,
        });
        return ok({
          ok: true,
          logId: log.id,
          actions: [completionAction(subtaskId, claimId)],
          nextSteps: [completionAction(subtaskId, claimId).tool + ': ' + completionAction(subtaskId, claimId).reason],
        });
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'get_implementation_logs',
    {
      description:
        'Read implementation logs for a ticket. Use this at the start of test/build stages ' +
        'to understand what was built during develop: which files were created/modified, ' +
        'what API endpoints and components exist, and integration patterns. ' +
        'Optionally filter by subtaskId to get logs for a specific subtask.',
      inputSchema: {
        repoId: z.string(),
        ticketId: z.string(),
        subtaskId: z.string().optional(),
      },
    },
    async ({ repoId, ticketId, subtaskId }) => {
      try {
        return ok(await app.getImplementationLogs(repoId, ticketId, subtaskId));
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  return server;
}

export async function startMcpServer(app: AppCore): Promise<McpServer> {
  const server = buildMcpServer(app);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server connected over stdio');
  return server;
}
