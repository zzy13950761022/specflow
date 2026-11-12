import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { AppCore } from '../core/app-core.js';
import { SpecFileSchema, SubtaskInputSchema, type SpecFile } from '../core/schemas.js';
import { runAgentTurn } from './agent-adapters.js';
import { applySourceChanges, sourceOutputSchema } from './source-changes.js';
import { fingerprint } from '../core/check-runner.js';
import type { AgentProfile } from '../core/agent-profile.js';
import { processGroupAlive } from '../core/processes.js';
import { git, prepareWorktree } from './workspaces.js';
import type { ExecuteTurn } from './orchestrator.js';

const artifactResult = z.object({
  content: z.string().trim().min(1), subtasks: z.array(SubtaskInputSchema).default([]),
  acceptanceCriteria: SpecFileSchema.shape.acceptanceCriteria,
  logsSanitized: z.boolean().default(false), checklistItems: z.array(z.object({ description: z.string().min(1), checked: z.boolean() })).default([]),
});
function artifactOutputSchema(acceptanceCriteria: SpecFile['acceptanceCriteria']) {
  return {
    type: 'object', additionalProperties: false,
    required: ['content', 'subtasks', 'acceptanceCriteria', 'logsSanitized', 'checklistItems'],
    properties: {
      content: { type: 'string' }, logsSanitized: { type: 'boolean' },
      subtasks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'description', 'dependsOn', 'files', 'requirementRef', 'testRefs'], properties: { id: { type: 'string' }, description: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } }, requirementRef: { type: 'string', enum: acceptanceCriteria.length ? acceptanceCriteria.map(criterion => criterion.id) : [''], description: 'Exactly one existing acceptance criterion ID, never a comma-separated list or range. Empty only when the ticket has no acceptance criteria.' }, testRefs: { type: 'array', items: { type: 'string' } } } } },
      acceptanceCriteria: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'given', 'when', 'then'], properties: { id: { type: 'string' }, given: { type: 'string' }, when: { type: 'string' }, then: { type: 'string' } } } },
      checklistItems: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['description', 'checked'], properties: { description: { type: 'string' }, checked: { type: 'boolean' } } } },
    },
  };
}
const implementationOutputSchema = { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } };
function lineChanges(before: Buffer | null, after: Buffer | null) {
  const lines = (value: Buffer | null) => value?.length ? value.toString('utf8').split(String.fromCharCode(10)) : [];
  const oldLines = lines(before), newLines = lines(after); let prefix = 0, suffix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  return { linesAdded: newLines.length - prefix - suffix, linesRemoved: oldLines.length - prefix - suffix };
}

async function changedFiles(repo: string): Promise<Map<string, Buffer | null>> {
  const names = new Set((await git(repo, ['diff', '--name-only', '-z', 'HEAD']) + await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split(String.fromCharCode(0)).filter((path) => path && !path.startsWith('.specflow/')));
  const result = new Map<string, Buffer | null>();
  for (const name of names) { try { result.set(name, await fs.readFile(join(repo, name))); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') result.set(name, null); else throw error; } }
  return result;
}

/** Host owns workflow mutations; each configured Agent returns one bounded task result. */
export function createCodexExecutor(app: AppCore, command = process.env.AI_PILOT_CODEX_BIN ?? 'codex', authPath?: string, configPath?: string): ExecuteTurn {
  return async (repoId, ticketId, runId, signal) => {
    const entry = await app.registry.resolve(repoId); if (!entry) throw new Error('Repository removed.');
    const worktree = await prepareWorktree(entry.path, ticketId);
    await app.updateAutomation(repoId, ticketId, (spec) => { app.assertAutomationRun(spec, runId); spec.automation!.worktreePath = worktree; });
    const spec = (await app.getSpec(repoId, ticketId))!;
    const action = (await app.getExecutionStatus(repoId, ticketId)).actions[0];
    if (!action) throw new Error('No executable workflow action.');
    const implementation = action.tool === 'claim_subtask' || action.tool === 'log_implementation';
    let task = implementation ? spec.stages[3].subtasks?.find((task) => task.id === action.subtaskId) : undefined;
    if (implementation && !task) throw new Error('No ready implementation task.');
    if (task && task.status !== 'running') {
      const claimed = await app.claimSubtask(repoId, ticketId, task.id, runId); task = claimed.stages[3].subtasks!.find((item) => item.id === task!.id)!;
    }
    const runtime = join(process.env.AI_PILOT_HOME ?? join(homedir(), '.specflow'), 'runners', repoId, ticketId);
    const profile: AgentProfile = spec.automation?.profile ?? { id: 'legacy-codex', name: 'Codex', version: 1, agent: 'codex', command, configPath };
    if (profile.agent === 'codex') {
      const nativeConfig = await fs.readFile(join(worktree, '.codex', 'config.toml'), 'utf8').catch((error) => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });
      if (/mcp_servers|hooks/.test(nativeConfig)) throw new Error('Managed execution requires a repository Codex configuration without MCP servers or hooks. Use interactive execution for this repository configuration.');
    }
    const hostApplied = profile.agent !== 'codex';
    let ownedPid: number | undefined;
    const initialFingerprint = hostApplied && implementation ? await fingerprint(worktree, entry.path) : undefined;
    const before = implementation ? await changedFiles(worktree) : undefined;
    try {
      const prompt = await app.getStagePrompt(repoId, ticketId, spec.currentStageId);
      const instructions = [
        'AI Pilot managed execution: execute ONLY the supplied stage artifact or claimed subtask in this turn.',
        'The host owns MCP mutations, plan registration, claims, check execution and approvals. Return structured output instead of calling MCP. Do not wait, approve, advance, create sessions, change Git metadata or run TEST/BUILD commands.',
        'This managed execution contract takes precedence over the interactive Specflow loop. Read repository AGENTS.md/CLAUDE.md.',
        'Ticket: ' + ticketId + '; stage: ' + spec.currentStageId + '; workspace: ' + worktree,
        task ? 'Implement this claimed task: ' + JSON.stringify(task) + '. Previous review: ' + JSON.stringify(task.reviewHistory?.at(-1) ?? null) : 'Generate the stage artifact. For DEVELOP return a nonempty task plan with stable IDs linked to SPEC acceptance criteria. Return empty arrays for irrelevant structured fields.',
        spec.currentStageId === 'develop' && !task ? 'Each subtask requirementRef must be exactly one of these persisted acceptance criterion IDs: ' + JSON.stringify(spec.acceptanceCriteria.map(criterion => criterion.id)) + '. Never join IDs with commas or use ranges. Plan appropriately scoped tasks linked to individual criteria. If no criteria exist, use an empty string; do not invent IDs.' : '',
        task ? 'Approved plan: ' + await app.readArtifact(repoId, ticketId, 'develop') : '',
        'Current review comment: ' + (spec.stages.find((stage) => stage.id === spec.currentStageId)?.gate.comment ?? ''),
        'Actual current-stage platform evidence: ' + JSON.stringify(spec.stages.find((stage) => stage.id === spec.currentStageId)?.evidence ?? null),
        prompt.content,
      ].join(String.fromCharCode(10, 10));
      const skillPath = fileURLToPath(new URL('../../skills/specflow/SKILL.md', import.meta.url));
      const { text: output } = await runAgentTurn({
        profile, cwd: worktree, runtime: profile.agent === 'codex' ? runtime : join(runtime, profile.agent),
        prompt: instructions + (hostApplied && implementation ? String.fromCharCode(10) + 'Read the current source using read tools. Return files with repository-relative path and COMPLETE new UTF-8 content (null to delete). The host validates and applies them. Do not edit files or run commands yourself.' : ''),
        schema: implementation ? (hostApplied ? sourceOutputSchema : implementationOutputSchema) : artifactOutputSchema(spec.acceptanceCriteria),
        signal, sessionId: spec.automation?.threadId, writable: implementation, skillPath, authPath,
        onPid: async pid => { ownedPid = pid; await app.updateAutomation(repoId, ticketId, current => { app.assertAutomationRun(current, runId); current.automation!.runnerPid = pid; }); },
        onSession: async session => { await app.updateAutomation(repoId, ticketId, current => { app.assertAutomationRun(current, runId); current.automation!.threadId = session; }); },
      });
      if (hostApplied && implementation) {
        await app.updateAutomation(repoId, ticketId, async current => {
          app.assertAutomationRun(current, runId);
          if (await fingerprint(worktree, entry.path) !== initialFingerprint) throw new Error('Source changed during generation. Inspect the worktree before retrying.');
          const changes = z.object({ summary: z.string().trim().min(1), files: z.array(z.object({ path: z.string(), content: z.string().nullable() })) }).parse(JSON.parse(output));
          await applySourceChanges(worktree, changes.files);
        });
      }
      const current = (await app.getSpec(repoId, ticketId))!; app.assertAutomationRun(current, runId);
      if (task && before) {
        const result = z.object({ summary: z.string().trim().min(1) }).parse(JSON.parse(output));
        const after = await changedFiles(worktree);
        const changed = [...new Set([...before.keys(), ...after.keys()])].filter((name) => !before.get(name)?.equals(after.get(name) ?? Buffer.alloc(0)) && !(before.get(name) === null && after.get(name) === null));
        if (!changed.length) throw new Error('Implementation returned no observable file changes. Inspect interrupted work before retrying.');
        const created: string[] = [], modified: string[] = []; const statistics = { linesAdded: 0, linesRemoved: 0 };
        for (const name of changed) {
          try { await git(worktree, ['cat-file', '-e', 'HEAD:' + name]); modified.push(name); } catch { created.push(name); }
          const prior = before.has(name) ? before.get(name)! : await git(worktree, ['show', 'HEAD:' + name]).then((text) => Buffer.from(text), () => null);
          const changes = lineChanges(prior, after.get(name) ?? null); statistics.linesAdded += changes.linesAdded; statistics.linesRemoved += changes.linesRemoved;
        }
        await app.logImplementation(repoId, ticketId, task.id, { claimId: task.claimId, summary: result.summary, filesModified: modified, filesCreated: created, statistics, artifacts: {} }, runId);
        await app.setSubtaskCompleted(repoId, ticketId, task.id, true, task.claimId, runId);
      } else {
        const result = artifactResult.parse(JSON.parse(output));
        if (spec.currentStageId === 'develop') {
          if (!result.subtasks.length) throw new Error('DEVELOP returned an empty plan.');
          await app.setDevelopSubtasks(repoId, ticketId, result.subtasks, runId);
        }
        const artifact = spec.currentStageId === 'ops' ? { kind: 'ops-report' as const, logsSanitized: result.logsSanitized } : spec.currentStageId === 'deploy' ? { kind: 'deploy-checklist' as const, items: result.checklistItems } : undefined;
        await app.recordAiOutput(repoId, ticketId, spec.currentStageId, result.content, artifact, spec.currentStageId === 'spec' ? result.acceptanceCriteria : undefined, runId);
      }
    } finally {
      await app.updateAutomation(repoId, ticketId, (current) => { if (ownedPid !== undefined && current.automation?.runnerPid === ownedPid && !processGroupAlive(ownedPid)) current.automation!.runnerPid = undefined; });
    }
  };
}

/** Generic entry point; the legacy export remains compatible with existing integrations. */
export const createAgentExecutor = createCodexExecutor;
