import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AppCore } from '../core/app-core.js';
import { StageIdSchema, type ArtifactInput } from '../core/schemas.js';
import { GateNotApprovedError } from '../core/stage-machine.js';
import { logger } from '../core/logger.js';

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
        'Create a new 8-stage spec for a ticket. Derives specPath from the title.',
      inputSchema: { repoId: z.string(), ticketId: z.string(), title: z.string() },
    },
    async ({ repoId, ticketId, title }) => {
      try {
        return ok(await app.createSpec(repoId, ticketId, title));
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
        'Gather repo signals (CLAUDE.md, build files, test framework, sample source file) ' +
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
        "Persist Claude's artifact for a stage, mark the AI action done, and " +
        'flip the human gate to pending_review. ' +
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
      },
    },
    async ({ repoId, ticketId, stageId, content, checklistItems, rollbackCriteria, logsSanitized, rcaPath, runbookPath, metrics }) => {
      try {
        let artifactInput: ArtifactInput | undefined;
        if (stageId === 'deploy' && checklistItems) {
          artifactInput = { kind: 'deploy-checklist', items: checklistItems, rollbackCriteria };
        } else if (stageId === 'ops') {
          artifactInput = { kind: 'ops-report', logsSanitized: logsSanitized ?? false, rcaPath, runbookPath, metrics };
        }
        return ok(await app.recordAiOutput(repoId, ticketId, stageId, content, artifactInput));
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'get_approval_status',
    {
      description:
        'Poll the human gate status for a stage. ' +
        'IMPORTANT: always act on the nextSteps field in the response — it tells you exactly what to do next. ' +
        'When status is pending_review: wait ~10 seconds, then call this tool again — do NOT ask the user, do NOT stop. ' +
        'When status is needs_revision: read gate.comment, call get_stage_prompt, regenerate, then record_ai_output. ' +
        'When status is approved: call advance_stage and proceed to the next stage. ' +
        'When status is rejected: read gate.comment, call get_stage_prompt, regenerate, then record_ai_output. ' +
        'Never accept verbal approval — only this tool is authoritative.',
      inputSchema: { repoId: z.string(), ticketId: z.string(), stageId: StageIdSchema },
    },
    async ({ repoId, ticketId, stageId }) => {
      try {
        const spec = await app.getSpec(repoId, ticketId);
        if (!spec) return fail(`Unknown spec: ${ticketId}`);
        const stage = spec.stages.find((s) => s.id === stageId);
        const gate = stage?.gate;

        const nextSteps: string[] = [];
        if (gate?.status === 'pending_review') {
          nextSteps.push('Gate is pending human review in the dashboard. Wait ~10 seconds then call get_approval_status again. Do NOT stop or ask the user.');
        } else if (gate?.status === 'needs_revision') {
          nextSteps.push(`Gate needs revision. Comment: "${gate.comment ?? ''}". Call get_stage_prompt to get the prompt, regenerate the output addressing the comment, then call record_ai_output.`);
        } else if (gate?.status === 'rejected') {
          nextSteps.push(`Gate was rejected. Comment: "${gate.comment ?? ''}". Call get_stage_prompt, regenerate addressing the comment, then call record_ai_output.`);
        } else if (gate?.status === 'approved') {
          nextSteps.push('Gate is approved. Call advance_stage to move to the next stage.');
        }

        return ok({ stageId, gate, nextSteps });
      } catch (e) {
        return fail(String((e as Error).message));
      }
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
        'Third gate verdict: ask Claude to revise the output without fully rejecting it. ' +
        'Sets gate to needs_revision and aiStatus to in_progress so Claude can re-record. ' +
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
        'Replace the DEVELOP stage subtask checklist wholesale. Each entry has a ' +
        'description and optional prompt (per-subtask AI guidance) and requirementRef. ' +
        'Existing subtasks are discarded. aiStatus is derived automatically.',
      inputSchema: {
        repoId: z.string(),
        ticketId: z.string(),
        subtasks: z.array(
          z.object({
            description: z.string().min(1),
            prompt: z.string().optional(),
            requirementRef: z.string().optional(),
          })
        ),
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

  return server;
}

export async function startMcpServer(app: AppCore): Promise<McpServer> {
  const server = buildMcpServer(app);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server connected over stdio');
  return server;
}
