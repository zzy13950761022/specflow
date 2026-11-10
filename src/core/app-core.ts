import { RepoRegistry, type RepoEntry } from './repo-registry.js';
import { SpecStore } from './spec-store.js';
import { StageMachine } from './stage-machine.js';
import { EventBus } from './event-bus.js';
import { PromptTemplates, type ResolvedTemplate, type TemplateSummary } from '../prompts/templates.js';
import { ImplLogStore } from './impl-log-store.js';
import { STAGE_IDS, SpecFileSchema, type SpecFile, type StageId, type ArtifactInput, type ImplArtifacts, type ImplementationLog, type WorkflowOptions } from './schemas.js';
import { logger } from './logger.js';
import type { RepoBrief } from './repo-introspector.js';
import { runCheck, fingerprint, assertEvidence, recoverRepositoryCheck } from './check-runner.js';
import { randomUUID } from 'crypto';
import { buildStageContext, traceability } from './stage-context.js';
import { canAutoApprove } from './workflow-policy.js';
import { nextActions, synchronizeExecution } from './execution.js';
import type { SubtaskInput } from './schemas.js';

/**
 * The shared singleton. Both the MCP server and the dashboard talk ONLY to
 * AppCore — never to the stores directly — so all gating rules and the
 * mutate->persist->emit flow live in exactly one place (Invariant #2).
 */
export class AppCore {
  readonly registry = new RepoRegistry();
  readonly store = new SpecStore();
  readonly stageMachine = new StageMachine();
  readonly templates = new PromptTemplates();
  readonly events = new EventBus();
  readonly implLogs = new ImplLogStore();

  /* ---- repos ---- */

  listRepos(): Promise<RepoEntry[]> {
    return this.registry.list();
  }

  async addRepo(path: string): Promise<RepoEntry> {
    const entry = await this.registry.add(path);
    this.events.emit({ type: 'repo.added', repoId: entry.id, path: entry.path });
    return entry;
  }

  async removeRepo(id: string): Promise<boolean> {
    const ok = await this.registry.remove(id);
    if (ok) this.events.emit({ type: 'repo.removed', repoId: id });
    return ok;
  }

  private async repoPath(repoId: string): Promise<string> {
    const entry = await this.registry.resolve(repoId);
    if (!entry) throw new Error(`Unknown repo: ${repoId}`);
    return entry.path;
  }

  /* ---- specs ---- */

  async listSpecs(repoId: string): Promise<SpecFile[]> {
    return this.store.list(await this.repoPath(repoId));
  }

  async getSpec(repoId: string, ticketId: string): Promise<SpecFile | null> {
    const spec = await this.store.read(await this.repoPath(repoId), ticketId);
    return spec ? synchronizeExecution(spec) : null;
  }

  async createSpec(repoId: string, ticketId: string, title: string, options: WorkflowOptions = {}): Promise<SpecFile> {
    const path = await this.repoPath(repoId);
    const saved = await this.store.transaction(path, ticketId, async (existing) => {
      if (existing) throw new Error(`Spec already exists: ${ticketId}`);
      return this.stageMachine.createSpec({ ticketId, title, ...options });
    });
    this.events.emit({ type: 'spec.created', repoId, spec: saved });
    return saved;
  }

  /* ---- prompts ---- */

  /** Render the stage prompt, feeding the approved upstream artifact as context. */
  async getStagePrompt(repoId: string, ticketId: string, stageId: StageId): Promise<ResolvedTemplate> {
    const path = await this.repoPath(repoId);
    const spec = await this.requireSpec(path, ticketId);
    await this.validateUpstreamChecks(spec, path, stageId);
    const context = await buildStageContext(path, spec, stageId, await this.implLogs.list(path, ticketId));
    const upstream = context.artifacts.at(-1)?.content;
    const prompt = await this.templates.render(path, stageId, {
      ticketId: spec.ticketId,
      title: spec.title,
      upstreamArtifact: upstream,
    });
    return { ...prompt, content: prompt.content + String.fromCharCode(10, 10) + '## Approved stage context' + String.fromCharCode(10) + JSON.stringify(context, null, 2) };
  }

  async getStageContext(repoId: string, ticketId: string, stageId: StageId) {
    const path = await this.repoPath(repoId);
    const spec = await this.requireSpec(path, ticketId);
    await this.validateUpstreamChecks(spec, path, stageId);
    return buildStageContext(path, spec, stageId, await this.implLogs.list(path, ticketId));
  }

  async getTraceability(repoId: string, ticketId: string) {
    const path = await this.repoPath(repoId);
    return traceability(await this.requireSpec(path, ticketId), await this.implLogs.list(path, ticketId));
  }

  /** Gather repo signals and return a brief for the agent to draft curated templates. */
  async proposeRepoTemplates(repoId: string): Promise<RepoBrief> {
    const path = await this.repoPath(repoId);
    return this.templates.generateCuratedTemplate(path, 'spec');
  }

  /** Persist a single draft template written by the agent. */
  async writeRepoTemplate(repoId: string, stageId: StageId, content: string): Promise<void> {
    const path = await this.repoPath(repoId);
    await this.templates.writeRepoTemplate(path, stageId, content);
  }

  /** Mark a template as human-curated. */
  async markTemplateCurated(repoId: string, stageId: StageId): Promise<void> {
    const path = await this.repoPath(repoId);
    await this.templates.markTemplateCurated(path, stageId);
  }

  /** List all 8 stage templates with their source status. */
  async listTemplates(repoId: string): Promise<TemplateSummary[]> {
    const path = await this.repoPath(repoId);
    return this.templates.listTemplates(path);
  }

  /* ---- stage transitions (all go mutate -> persist -> emit) ---- */

  async recordAiOutput(
    repoId: string,
    ticketId: string,
    stageId: StageId,
    content: string,
    artifactInput?: ArtifactInput,
    acceptanceCriteria?: SpecFile['acceptanceCriteria']
  ): Promise<SpecFile> {
    const path = await this.repoPath(repoId);
    return this.mutate(repoId, ticketId, async (spec) => {
      // Validate before writing files, so rejected submissions leave the reviewed artifact intact.
      this.stageMachine.recordAiOutput(spec, stageId, { kind: 'markdown', path: '' });
      if (!content.trim()) throw new Error('Artifact content must be non-empty.');
      await this.validateUpstreamChecks(spec, path, stageId);
      if (acceptanceCriteria) {
        if (stageId !== 'spec') throw new Error('Acceptance criteria can only be set with the spec artifact.');
        if (new Set(acceptanceCriteria.map((criterion) => criterion.id)).size !== acceptanceCriteria.length) throw new Error('Acceptance criterion IDs must be unique.');
        spec.acceptanceCriteria = SpecFileSchema.shape.acceptanceCriteria.parse(acceptanceCriteria);
      }
      const stageIndex = STAGE_IDS.indexOf(stageId);
      const { artifact, history } = await this.store.writeArtifact(
      path,
      ticketId,
      stageId,
      stageIndex,
      content,
      spec.specPath,
      artifactInput
    );
      return this.applyApprovalPolicy(this.stageMachine.recordAiOutput(spec, stageId, artifact, history), path);
    });
  }

  async approve(repoId: string, ticketId: string, stageId: StageId, expectedRevision?: number): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec, path) => {
      await this.validateCheckEvidence(spec, path, stageId);
      return this.stageMachine.approve(spec, stageId, expectedRevision);
    });
  }

  async reject(repoId: string, ticketId: string, stageId: StageId, comment: string, expectedRevision?: number): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec) => this.stageMachine.reject(spec, stageId, comment, expectedRevision));
  }

  async requestRevision(repoId: string, ticketId: string, stageId: StageId, comment: string, expectedRevision?: number): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec) => this.stageMachine.requestRevision(spec, stageId, comment, expectedRevision));
  }

  /** Throws GateNotApprovedError if the current gate isn't approved. */
  async advance(repoId: string, ticketId: string, stageId: StageId): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec, path) => {
      await this.validateCheckEvidence(spec, path, stageId);
      if (stageId === 'develop') {
        const logs = await this.implLogs.list(path, ticketId);
        for (const task of spec.stages[3].subtasks ?? []) if (task.completed && !logs.some((log) => log.subtaskId === task.id && log.developRevision === spec.stages[3].revision && log.taskAttempt === task.attempt)) {
          throw new Error('Current implementation log is missing for task ' + task.id + '. Reopen and revalidate implementation.');
        }
      }
      return this.stageMachine.advance(spec, stageId);
    });
  }

  private async validateCheckEvidence(spec: SpecFile, path: string, stageId: StageId): Promise<void> {
    await this.validateUpstreamChecks(spec, path, stageId);
    if (stageId === 'test' || stageId === 'build') assertEvidence(spec.stages.find((stage) => stage.id === stageId)?.evidence, stageId, await fingerprint(path));
  }

  private async validateUpstreamChecks(spec: SpecFile, path: string, stageId: StageId): Promise<void> {
    const checks = spec.stages.slice(0, STAGE_IDS.indexOf(stageId)).filter((stage) => !stage.skipped && (stage.id === 'test' || stage.id === 'build'));
    if (!checks.length) return;
    const current = await fingerprint(path);
    for (const stage of checks) if (stage.id === 'test' || stage.id === 'build') assertEvidence(stage.evidence, stage.id, current);
  }

  private async applyApprovalPolicy(spec: SpecFile, path: string): Promise<SpecFile> {
    const stage = spec.stages.find((stage) => stage.id === spec.currentStageId)!;
    if (stage.gate.status === 'pending_review' && stage.evidence && canAutoApprove(spec, stage.id)) {
      try { await this.validateCheckEvidence(spec, path, stage.id); }
      catch { return spec; }
      return this.stageMachine.approve(spec, stage.id, stage.revision, 'policy');
    }
    return spec;
  }

  async runStageCheck(repoId: string, ticketId: string, stageId: 'test' | 'build'): Promise<SpecFile> {
    const runId = randomUUID();
    await this.mutate(repoId, ticketId, async (spec, path) => {
      this.stageMachine.assertCurrent(spec, stageId);
      await this.validateUpstreamChecks(spec, path, stageId);
      const stage = spec.stages.find((stage) => stage.id === stageId)!;
      if (stage.activeCheck) throw new Error('A check is already running; recover interrupted execution before retrying.');
      if (stage.gate.status === 'approved') throw new Error('Reopen the approved stage before running another check.');
      stage.activeCheck = { runId, pid: process.pid, revision: stage.revision };
      if (spec.execution.error) spec.execution.retryCount++;
      spec.execution.error = undefined;
      stage.evidence = undefined;
      return spec;
    });
    try {
      const evidence = await runCheck(await this.repoPath(repoId), ticketId, stageId, runId);
      return await this.mutate(repoId, ticketId, async (spec, path) => {
        const stage = spec.stages.find((stage) => stage.id === stageId)!;
        if (stage.activeCheck?.runId !== runId) throw new Error('Check superseded by rework; discard this result.');
        stage.activeCheck = undefined;
        stage.evidence = evidence;
        try { assertEvidence(evidence, stageId); spec.execution.lastSuccessfulStep = 'run_stage_check:' + stageId; spec.execution.error = undefined; }
        catch (error) { spec.execution.error = String((error as Error).message); }
        return this.applyApprovalPolicy(spec, path);
      });
    } catch (error) {
      await this.mutate(repoId, ticketId, async (spec) => {
        const stage = spec.stages.find((stage) => stage.id === stageId)!;
        if (stage.activeCheck?.runId === runId) { stage.activeCheck = undefined; spec.execution.error = String((error as Error).message); }
        return spec;
      });
      throw error;
    }
  }

  /* ---- develop subtasks (Phase 3) ---- */

  async reopenStage(repoId: string, ticketId: string, stageId: StageId, reason: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec) => this.stageMachine.reopen(spec, stageId, reason));
  }

  /** Replace the DEVELOP subtask list wholesale; updates derived aiStatus. */
  async setDevelopSubtasks(
    repoId: string,
    ticketId: string,
    subtasks: SubtaskInput[]
  ): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec) => this.stageMachine.setSubtasks(spec, subtasks));
  }

  /** Toggle a single subtask's completed flag; updates derived aiStatus. */
  async toggleSubtask(repoId: string, ticketId: string, subtaskId: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec, path) => {
      const task = spec.stages[3].subtasks?.find((task) => task.id === subtaskId);
      if (!task) throw new Error(`Unknown subtask id: ${subtaskId}`);
      return this.completeSubtask(spec, path, subtaskId, !task.completed);
    });
  }

  async setSubtaskCompleted(repoId: string, ticketId: string, subtaskId: string, completed: boolean, claimId?: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, (spec, path) => this.completeSubtask(spec, path, subtaskId, completed, claimId));
  }

  private async completeSubtask(spec: SpecFile, path: string, subtaskId: string, completed: boolean, claimId?: string): Promise<SpecFile> {
    this.stageMachine.assertImplementation(spec);
    const task = spec.stages[3].subtasks?.find((task) => task.id === subtaskId);
    if (!task) throw new Error(`Unknown subtask id: ${subtaskId}`);
    const next = this.stageMachine.setSubtaskCompleted(spec, subtaskId, completed, claimId);
    if (task.completed === completed) return spec;
    if (completed) {
      const logs = await this.implLogs.list(path, spec.ticketId, subtaskId);
      if (!logs.some((log) => log.developRevision === spec.stages[3].revision && log.taskAttempt === task.attempt)) throw new Error('Record a current-revision implementation log before completing this task.');
    }
    next.execution.lastSuccessfulStep = 'set_subtask_completed:' + subtaskId;
    return next;
  }

  async claimSubtask(repoId: string, ticketId: string, subtaskId: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec) => { spec.execution.error = undefined; return this.stageMachine.claimSubtask(spec, subtaskId); });
  }

  async releaseSubtask(repoId: string, ticketId: string, subtaskId: string, claimId: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec) => this.stageMachine.releaseSubtask(spec, subtaskId, claimId));
  }

  async getExecutionStatus(repoId: string, ticketId: string) {
    const spec = await this.getSpec(repoId, ticketId);
    if (!spec) throw new Error('Unknown spec: ' + ticketId);
    let actions = nextActions(spec);
    const stage = spec.stages.find((stage) => stage.id === spec.currentStageId)!;
    if (spec.execution.status !== 'paused' && spec.execution.status !== 'completed') {
      const checks = spec.stages.slice(0, STAGE_IDS.indexOf(spec.currentStageId) + 1).filter((item) => !item.skipped && (item.id === 'test' || item.id === 'build'));
      const code = checks.length ? await fingerprint(await this.repoPath(repoId)) : undefined;
      for (const check of checks) {
        if (check.activeCheck || (!check.evidence && check.id === stage.id && check.gate.status !== 'approved')) continue;
        try { if (check.id === 'test' || check.id === 'build') assertEvidence(check.evidence, check.id, code); }
        catch (error) {
          actions = [{ tool: check.gate.status === 'approved' || check.id !== stage.id ? 'reopen_stage' : 'run_stage_check', stageId: check.id, reason: check.id + ': ' + String((error as Error).message) }];
          break;
        }
      }
    }
    return { ...spec.execution, stageId: spec.currentStageId, actions };
  }

  async pauseExecution(repoId: string, ticketId: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec) => {
      if (spec.execution.status === 'completed') throw new Error('Completed execution cannot be paused.');
      spec.execution.status = 'paused'; return spec;
    });
  }

  async waitForApproval(repoId: string, ticketId: string, stageId: StageId, waitMs = 30_000, signal?: AbortSignal) {
    if (waitMs < 0 || waitMs > 60_000) throw new Error('waitMs must be between 0 and 60000.');
    const read = async () => {
      const spec = await this.getSpec(repoId, ticketId);
      if (!spec) throw new Error('Unknown spec: ' + ticketId);
      const stage = spec.stages.find((stage) => stage.id === stageId)!;
      return { gate: stage.gate, revision: stage.revision };
    };
    const initial = await read();
    if (initial.gate.status !== 'pending_review' || waitMs === 0) return initial.gate;
    return new Promise<typeof initial.gate>((resolveWait, rejectWait) => {
      let finished = false; let unsubscribe = () => {};
      const cleanup = () => { clearTimeout(timer); clearInterval(poller); unsubscribe(); signal?.removeEventListener('abort', abort); };
      const finish = (gate?: typeof initial.gate, error?: unknown) => {
        if (finished) return; finished = true; cleanup();
        if (error) rejectWait(error); else resolveWait(gate!);
      };
      const check = async (force = false) => {
        try { const current = await read(); if (force || current.gate.status !== 'pending_review' || current.revision !== initial.revision) finish(current.gate); }
        catch (error) { finish(undefined, error); }
      };
      const abort = () => finish(undefined, new Error('Approval wait cancelled.'));
      const timer = setTimeout(() => void check(true), waitMs);
      const poller = setInterval(() => void check(), 250);
      unsubscribe = this.events.subscribe((event) => {
        if (event.type === 'spec.updated' && event.repoId === repoId && event.spec.ticketId === ticketId) void check();
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else void check();
    });
  }

  async resumeExecution(repoId: string, ticketId: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec, path) => {
      await recoverRepositoryCheck(path);
      spec.execution.status = 'ready'; spec.execution.error = undefined;
      for (const stage of spec.stages) if (stage.activeCheck) {
        let alive = true;
        try { process.kill(stage.activeCheck.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (!alive) {
          stage.activeCheck = undefined; stage.evidence = undefined;
          spec.execution.error = 'Previous check was interrupted. Review and explicitly rerun it.'; spec.execution.retryCount++;
        }
      }
      return spec;
    });
  }

  /* ---- artifact content ---- */

  /** Review one immutable artifact snapshot and its revision from a single state read. */
  async getArtifactReview(repoId: string, ticketId: string, stageId: StageId) {
    const path = await this.repoPath(repoId);
    const spec = await this.requireSpec(path, ticketId);
    const stage = spec.stages.find((stage) => stage.id === stageId)!;
    if (!stage.artifact) throw new Error('No artifact for this stage.');
    const history = stage.artifactHistory?.slice().reverse().find((entry) => entry.revision === stage.revision);
    const snapshot = history?.artifact ?? stage.artifact;
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    const content = await readFile(join(path, history?.path ?? snapshot.path), 'utf8');
    const data = snapshot.kind === 'requirements' ? JSON.parse(await readFile(join(path, snapshot.dataPath), 'utf8')) : null;
    return { stageId, revision: stage.revision, content, artifact: stage.artifact, data };
  }

  /** Read a stage's own AI artifact content, or null if none/unreadable. */
  async readArtifact(
    repoId: string,
    ticketId: string,
    stageId: StageId
  ): Promise<string | null> {
    const path = await this.repoPath(repoId);
    const spec = await this.requireSpec(path, ticketId);
    const stage = spec.stages.find((s) => s.id === stageId);
    if (!stage?.artifact?.path) return null;
    try {
      const { readFile } = await import('fs/promises');
      const { join } = await import('path');
      return await readFile(join(path, stage.artifact.path), 'utf-8');
    } catch (err) {
      logger.warn('Could not read artifact', stage.artifact.path, String(err));
      return null;
    }
  }

  /**
   * Read a stage's structured artifact sidecar as a parsed object, or null if
   * the stage has no structured data / it's unreadable. Currently only the
   * 'requirements' artifact kind carries a JSON sidecar (dataPath).
   */
  async readArtifactData(
    repoId: string,
    ticketId: string,
    stageId: StageId
  ): Promise<unknown | null> {
    const path = await this.repoPath(repoId);
    const spec = await this.requireSpec(path, ticketId);
    const stage = spec.stages.find((s) => s.id === stageId);
    if (stage?.artifact?.kind !== 'requirements') return null;
    try {
      const { readFile } = await import('fs/promises');
      const { join } = await import('path');
      const raw = await readFile(join(path, stage.artifact.dataPath), 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      logger.warn('Could not read artifact data', stage.artifact.dataPath, String(err));
      return null;
    }
  }

  /* ---- implementation logs (develop stage) ---- */

  /** Record a subtask implementation after the code is written. */
  async logImplementation(
    repoId: string,
    ticketId: string,
    subtaskId: string,
    input: {
      claimId?: string;
      summary: string;
      filesModified: string[];
      filesCreated: string[];
      statistics: { linesAdded: number; linesRemoved: number };
      artifacts: ImplArtifacts;
    }
  ): Promise<ImplementationLog> {
    const { artifacts } = input;
    const hasArtifacts =
      (artifacts.apiEndpoints?.length ?? 0) > 0 ||
      (artifacts.components?.length ?? 0) > 0 ||
      (artifacts.functions?.length ?? 0) > 0 ||
      (artifacts.classes?.length ?? 0) > 0 ||
      (artifacts.integrations?.length ?? 0) > 0;

    if (!hasArtifacts && input.filesModified.length + input.filesCreated.length === 0) {
      throw new Error(
        'Record at least one changed/created file or an artifacts entry: apiEndpoints, components, functions, classes, integrations. ' +
        'An implementation with no files and no artifacts is not accepted — document what was actually built.'
      );
    }

    let log!: ImplementationLog;
    await this.mutate(repoId, ticketId, async (spec, path) => {
      this.stageMachine.assertImplementation(spec);
      if (!spec.stages[3].subtasks?.some((task) => task.id === subtaskId)) throw new Error(`Unknown subtask id: ${subtaskId}`);
      const task = spec.stages[3].subtasks!.find((task) => task.id === subtaskId)!;
      if (task.status === 'running' && task.claimId !== input.claimId) throw new Error('Current task claimId is required for logging.');
      log = await this.implLogs.write(path, ticketId, subtaskId, { ...input, developRevision: spec.stages[3].revision, taskAttempt: task.attempt });
      return spec;
    });
    return log;
  }

  /** Read implementation logs for a ticket, optionally filtered by subtask. */
  async getImplementationLogs(
    repoId: string,
    ticketId: string,
    subtaskId?: string
  ): Promise<ImplementationLog[]> {
    const path = await this.repoPath(repoId);
    return this.implLogs.list(path, ticketId, subtaskId);
  }

  /* ---- internals ---- */

  private async requireSpec(path: string, ticketId: string): Promise<SpecFile> {
    const spec = await this.store.read(path, ticketId);
    if (!spec) throw new Error(`Unknown spec: ${ticketId}`);
    return spec;
  }

  private async mutate(repoId: string, ticketId: string, op: (spec: SpecFile, path: string) => Promise<SpecFile>): Promise<SpecFile> {
    const path = await this.repoPath(repoId);
    const saved = await this.store.transaction(path, ticketId, async (spec) => {
      if (!spec) throw new Error(`Unknown spec: ${ticketId}`);
      const next = synchronizeExecution(await op(spec, path));
      next.updatedAt = new Date().toISOString();
      return next;
    });
    this.events.emit({ type: 'spec.updated', repoId, spec: saved });
    return saved;
  }

}
