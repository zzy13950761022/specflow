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
import { promises as fs } from 'fs';
import { join } from 'path';
import { resetTaskAndDependents } from './task-scheduler.js';
import { implementationReport } from './implementation-report.js';
import { processGroupAlive } from './processes.js';
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

  async executionPath(repoId: string, ticketId: string): Promise<string> {
    const path = await this.repoPath(repoId);
    const spec = await this.requireSpec(path, ticketId);
    return spec.automation?.worktreePath ?? path;
  }

  private sourcePath(spec: SpecFile, path: string): string { return spec.automation?.worktreePath ?? path; }

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
    acceptanceCriteria?: SpecFile['acceptanceCriteria'],
    expectedRunId?: string
  ): Promise<SpecFile> {
    const path = await this.repoPath(repoId);
    return this.mutate(repoId, ticketId, async (spec) => {
      // Validate before writing files, so rejected submissions leave the reviewed artifact intact.
      this.assertAutomationRun(spec, expectedRunId);
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
  async advance(repoId: string, ticketId: string, stageId: StageId, expectedRunId?: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec, path) => {
      this.assertAutomationRun(spec, expectedRunId);
      await this.validateCheckEvidence(spec, path, stageId);
      if (stageId === 'develop') {
        const source = await fingerprint(this.sourcePath(spec, path), path);
        if (spec.stages[3].subtasks?.some((task) => task.review?.status === 'approved' && task.review.codeFingerprint !== source)) throw new Error('Implementation source changed after review. Submit a fresh implementation review.');
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
    if (stageId === 'test' || stageId === 'build') assertEvidence(spec.stages.find((stage) => stage.id === stageId)?.evidence, stageId, await fingerprint(this.sourcePath(spec, path), path));
  }

  private async validateUpstreamChecks(spec: SpecFile, path: string, stageId: StageId): Promise<void> {
    if (STAGE_IDS.indexOf(stageId) >= 4 && spec.stages[3].subtasks?.length && !spec.legacyCompletion) {
      const source = await fingerprint(this.sourcePath(spec, path), path);
      if (spec.stages[3].subtasks.some((task) => !task.completed || task.review?.status !== 'approved' || task.review.developRevision !== spec.stages[3].revision || task.review.taskAttempt !== task.attempt || task.review.codeFingerprint !== source)) throw new Error('Implementation review is missing or source changed; reopen DEVELOP and review the current implementation.');
    }
    const checks = spec.stages.slice(0, STAGE_IDS.indexOf(stageId)).filter((stage) => !stage.skipped && (stage.id === 'test' || stage.id === 'build'));
    if (!checks.length) return;
    const current = await fingerprint(this.sourcePath(spec, path), path);
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

  async runStageCheck(repoId: string, ticketId: string, stageId: 'test' | 'build', expectedRunId?: string): Promise<SpecFile> {
    const runId = randomUUID();
    await this.mutate(repoId, ticketId, async (spec, path) => {
      this.assertAutomationRun(spec, expectedRunId);
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
      const evidence = await runCheck(await this.executionPath(repoId, ticketId), ticketId, stageId, runId, await this.repoPath(repoId));
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

  async submitImplementationReview(repoId: string, ticketId: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec, path) => {
      this.stageMachine.assertImplementation(spec);
      const stage = spec.stages[3];
      if (!stage.subtasks?.length || stage.subtasks.some((task) => !task.completed)) throw new Error('Complete all implementation subtasks before review submission.');
      const source = await fingerprint(this.sourcePath(spec, path), path);
      const logs = await this.implLogs.list(path, ticketId);
      for (const task of stage.subtasks) {
        if (task.review?.codeFingerprint === source && task.review.developRevision === stage.revision && task.review.taskAttempt === task.attempt) continue;
        const current = logs.filter((log) => log.subtaskId === task.id && log.developRevision === stage.revision && log.taskAttempt === task.attempt);
        if (!current.length) throw new Error('Current implementation log is missing for task ' + task.id);
        const id = randomUUID();
        const reportPath = join('.specflow', 'implementation-reviews', ticketId, id + '.md');
        const content = await implementationReport(this.sourcePath(spec, path), task, source, current);
        await fs.mkdir(join(path, '.specflow', 'implementation-reviews', ticketId), { recursive: true });
        await fs.writeFile(join(path, reportPath), content, { flag: 'wx' });
        if (task.review) task.reviewHistory = [...(task.reviewHistory ?? []), task.review];
        task.review = { id, status: 'pending_review', developRevision: stage.revision, taskAttempt: task.attempt, codeFingerprint: source, reportPath, submittedAt: new Date().toISOString() };
      }
      return spec;
    });
  }

  async getImplementationReview(repoId: string, ticketId: string, subtaskId: string) {
    const path = await this.repoPath(repoId);
    const spec = await this.requireSpec(path, ticketId);
    const task = spec.stages[3].subtasks?.find((task) => task.id === subtaskId);
    if (!task?.review) throw new Error('No implementation review for this task.');
    return { review: task.review, content: await fs.readFile(join(path, task.review.reportPath), 'utf8'), sourceChanged: task.review.codeFingerprint !== await fingerprint(this.sourcePath(spec, path), path) };
  }

  async reviewImplementation(repoId: string, ticketId: string, subtaskId: string, expectedReviewId: string, verdict: 'approved' | 'rejected' | 'needs_revision', comment?: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec, path) => {
      this.stageMachine.assertCurrent(spec, 'develop', true);
      const stage = spec.stages[3];
      const task = stage.subtasks?.find((task) => task.id === subtaskId);
      const review = task?.review;
      if (!task?.completed || !review || review.id !== expectedReviewId || review.developRevision !== stage.revision || review.taskAttempt !== task.attempt || review.status !== 'pending_review') throw new Error('Implementation review changed. Refresh the report before reviewing.');
      if (verdict === 'approved' && review.codeFingerprint !== await fingerprint(this.sourcePath(spec, path), path)) throw new Error('Implementation source changed. Submit a fresh review.');
      if (verdict !== 'approved' && !comment?.trim()) throw new Error('A revision or rejection comment is required.');
      review.status = verdict; review.comment = comment?.trim(); review.reviewedAt = new Date().toISOString();
      if (verdict !== 'approved') {
        task.reviewHistory = [...(task.reviewHistory ?? []), { ...review }];
        resetTaskAndDependents(stage.subtasks!, subtaskId);
        for (const other of stage.subtasks!) other.review = undefined;
        stage.aiStatus = 'in_progress';
      }
      return spec;
    });
  }

  async reopenStage(repoId: string, ticketId: string, stageId: StageId, reason: string, expectedRunId?: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec) => { if (spec.automation?.status === 'running') this.assertAutomationRun(spec, expectedRunId); return this.stageMachine.reopen(spec, stageId, reason); });
  }

  /** Replace the DEVELOP subtask list wholesale; updates derived aiStatus. */
  async setDevelopSubtasks(
    repoId: string,
    ticketId: string,
    subtasks: SubtaskInput[], expectedRunId?: string
  ): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec) => { this.assertAutomationRun(spec, expectedRunId); return this.stageMachine.setSubtasks(spec, subtasks); });
  }

  /** Toggle a single subtask's completed flag; updates derived aiStatus. */
  async toggleSubtask(repoId: string, ticketId: string, subtaskId: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec, path) => {
      this.assertAutomationRun(spec);
      const task = spec.stages[3].subtasks?.find((task) => task.id === subtaskId);
      if (!task) throw new Error(`Unknown subtask id: ${subtaskId}`);
      return this.completeSubtask(spec, path, subtaskId, !task.completed);
    });
  }

  async setSubtaskCompleted(repoId: string, ticketId: string, subtaskId: string, completed: boolean, claimId?: string, expectedRunId?: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, (spec, path) => { this.assertAutomationRun(spec, expectedRunId); return this.completeSubtask(spec, path, subtaskId, completed, claimId); });
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

  async claimSubtask(repoId: string, ticketId: string, subtaskId: string, expectedRunId?: string): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec) => { this.assertAutomationRun(spec, expectedRunId); spec.execution.error = undefined; return this.stageMachine.claimSubtask(spec, subtaskId); });
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
      const tasks = spec.stages[3].subtasks;
      if (tasks?.length && !spec.legacyCompletion && (STAGE_IDS.indexOf(spec.currentStageId) >= 4 || (spec.currentStageId === 'develop' && tasks.every((task) => task.completed)))) {
        const source = await fingerprint(await this.executionPath(repoId, ticketId), await this.repoPath(repoId));
        const invalid = tasks.some((task) => !task.completed || task.review?.status !== 'approved' || task.review.developRevision !== spec.stages[3].revision || task.review.taskAttempt !== task.attempt || task.review.codeFingerprint !== source);
        if (invalid && STAGE_IDS.indexOf(spec.currentStageId) >= 4) return { ...spec.execution, stageId: spec.currentStageId, actions: [{ tool: 'reopen_stage', stageId: 'develop' as const, reason: 'Implementation source changed or review is missing; review the current implementation.' }] };
        if (spec.currentStageId === 'develop' && tasks.some((task) => task.review && task.review.codeFingerprint !== source)) actions = [{ tool: 'submit_implementation_review', stageId: 'develop', reason: 'Implementation source changed; submit fresh review reports.' }];
      }
      const checks = spec.stages.slice(0, STAGE_IDS.indexOf(spec.currentStageId) + 1).filter((item) => !item.skipped && (item.id === 'test' || item.id === 'build'));
      const code = checks.length ? await fingerprint(await this.executionPath(repoId, ticketId), await this.repoPath(repoId)) : undefined;
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
      spec.execution.status = 'paused';
      if (spec.automation) { spec.automation.status = 'paused'; spec.automation.runId = undefined; }
      return spec;
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
      if (processGroupAlive(spec.automation?.runnerPid)) throw new Error('Previous Codex process is still stopping. Wait before resuming.');
      await recoverRepositoryCheck(this.sourcePath(spec, path));
      if (await fs.stat(join(this.sourcePath(spec, path), '.specflow', 'repository-check.lock')).catch(() => null)) {
        throw new Error('Previous platform check lock is still active. Wait before recovery.');
      }
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
    }, expectedRunId?: string
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
      this.assertAutomationRun(spec, expectedRunId);
      this.stageMachine.assertImplementation(spec);
      if (!spec.stages[3].subtasks?.some((task) => task.id === subtaskId)) throw new Error(`Unknown subtask id: ${subtaskId}`);
      const task = spec.stages[3].subtasks!.find((task) => task.id === subtaskId)!;
      if (task.review) throw new Error('Implementation is under review. Reset or revise the task before changing its log.');
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

  assertAutomationRun(spec: SpecFile, runId?: string): void {
    if (spec.automation?.enabled && !runId) throw new Error('Managed ticket mutations require the current automation run. Disable automation before using an interactive agent.');
    if (runId && (spec.automation?.runId !== runId || spec.automation.status !== 'running' || !spec.automation.enabled || spec.execution.status === 'paused')) throw new Error('Automation run is no longer current; discard its result.');
  }

  async updateAutomation(repoId: string, ticketId: string, op: (spec: SpecFile) => void): Promise<SpecFile> {
    return this.mutate(repoId, ticketId, async (spec) => { op(spec); return spec; });
  }

  async configureAutomation(repoId: string, ticketId: string, enabled: boolean): Promise<SpecFile> {
    return this.updateAutomation(repoId, ticketId, (spec) => {
      if (spec.automation?.status === 'running') throw new Error('Pause the active run before changing automation.');
      if (processGroupAlive(spec.automation?.runnerPid)) throw new Error('Previous Codex process is still alive. Stop it before retrying.');
      if (enabled) spec.execution.error = undefined;
      spec.automation = { ...spec.automation, enabled, status: spec.execution.status === 'completed' ? 'completed' : spec.execution.status === 'paused' ? 'paused' : 'queued', attempt: spec.automation?.attempt ?? 0, error: undefined, runId: undefined };
    });
  }

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
      next.stateVersion = (spec.stateVersion ?? 0) + 1;
      next.updatedAt = new Date().toISOString();
      return next;
    });
    this.events.emit({ type: 'spec.updated', repoId, spec: saved });
    return saved;
  }

}
