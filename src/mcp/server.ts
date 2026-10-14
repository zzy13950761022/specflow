import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AppCore } from '../core/app-core.js';
import { StageIdSchema } from '../core/schemas.js';
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
        'flip the human gate to pending_review.',
      inputSchema: {
        repoId: z.string(),
        ticketId: z.string(),
        stageId: StageIdSchema,
        content: z.string(),
      },
    },
    async ({ repoId, ticketId, stageId, content }) => {
      try {
        return ok(await app.recordAiOutput(repoId, ticketId, stageId, content));
      } catch (e) {
        return fail(String((e as Error).message));
      }
    }
  );

  server.registerTool(
    'get_approval_status',
    {
      description:
        'Poll the human gate status for a stage (not_ready | pending_review | approved | rejected). ' +
        'Poll with bounded backoff; do not busy-wait.',
      inputSchema: { repoId: z.string(), ticketId: z.string(), stageId: StageIdSchema },
    },
    async ({ repoId, ticketId, stageId }) => {
      try {
        const spec = await app.getSpec(repoId, ticketId);
        if (!spec) return fail(`Unknown spec: ${ticketId}`);
        const stage = spec.stages.find((s) => s.id === stageId);
        return ok({ stageId, gate: stage?.gate });
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

  return server;
}

export async function startMcpServer(app: AppCore): Promise<McpServer> {
  const server = buildMcpServer(app);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server connected over stdio');
  return server;
}
