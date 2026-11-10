import {
  STAGE_IDS,
  SCHEMA_VERSION,
  type SpecFile,
  type Stage,
  type StageId,
  type AiCapability,
  type GateStatus,
  type Artifact,
  WorkflowOptionsSchema,
  type WorkflowOptions,
  type SubtaskInput,
} from './schemas.js';
import { randomUUID } from 'crypto';
import { assertEvidence } from './check-runner.js';
import { WORKFLOW_STAGES } from './workflow-policy.js';
import { validateTasks, filesConflict, resetTaskAndDependents } from './task-scheduler.js';

/** Thrown when advance_stage is called but the current gate is not approved. */
export class GateNotApprovedError extends Error {
  readonly code = 'GATE_NOT_APPROVED';
  constructor(stageId: StageId, actual: GateStatus) {
    super(`Cannot advance stage "${stageId}": gate is "${actual}", must be "approved".`);
    this.name = 'GateNotApprovedError';
  }
}

/**
 * Single source of truth for which stages run real AI automation.
 * Phase 5 flips all 8 stages to auto. The set is exported so tests can
 * assert the mapping and callers can read it without depending on the
 * StageMachine constructor.
 */
export const AUTO_STAGES: ReadonlySet<StageId> = new Set<StageId>([...STAGE_IDS]);

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Pure domain logic for the 8-stage lifecycle. No I/O — every method takes a
 * SpecFile and returns a new one, so SpecStore owns persistence and both the
 * MCP and dashboard transports share one rule set.
 */
export class StageMachine {
  createSpec(input: { ticketId: string; title: string } & WorkflowOptions): SpecFile {
    const workflow = WorkflowOptionsSchema.parse(input);
    const stages: Stage[] = STAGE_IDS.map((id) => {
      const capability: AiCapability = AUTO_STAGES.has(id) ? 'auto' : 'stub';
      const stage: Stage = {
        id,
        revision: 0,
        stale: false,
        skipped: !WORKFLOW_STAGES[workflow.workflowKind].includes(id),
        skipReason: WORKFLOW_STAGES[workflow.workflowKind].includes(id) ? undefined : 'Not applicable to the ' + workflow.workflowKind + ' workflow.',
        aiCapability: capability,
        aiStatus: capability === 'stub' ? 'stubbed' : 'not_started',
        gate: { status: 'not_ready' },
      };
      if (id === 'develop') stage.subtasks = [];
      return stage;
    });

    const timestamp = now();
    return {
      schemaVersion: SCHEMA_VERSION,
      ticketId: input.ticketId,
      title: input.title,
      specPath: `.specflow/specs/${input.ticketId}-${slugify(input.title)}.md`,
      currentStageId: 'spec',
      acceptanceCriteria: [],
      workflow,
      execution: { status: 'ready', retryCount: 0 },
      stages,
      gateHistory: [],
      reworkHistory: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  recordAiOutput(
    spec: SpecFile,
    stageId: StageId,
    artifact: Artifact,
    historyEntry?: { path: string; at: string; artifact?: Artifact }
  ): SpecFile {
    this.assertCurrent(spec, stageId);
    if (this.stage(spec, stageId).activeCheck) throw new Error('A check is running. Wait for completion before submitting an artifact.');
    const status = this.stage(spec, stageId).gate.status;
    if (status === 'pending_review' || status === 'approved') {
      throw new Error('Artifact is under review or approved. Request revision or reopen the stage before resubmitting.');
    }
    return this.mutateStage(spec, stageId, (next, stage) => {
      stage.revision++;
      stage.stale = false;
      stage.staleReason = undefined;
      stage.gate.approvedRevision = undefined;
      stage.gate.actor = undefined;
      stage.gate.reviewedAt = undefined;
      stage.aiStatus = stageId === 'develop' && (stage.subtasks?.length ?? 0) > 0 ? 'in_progress' : 'done';
      stage.artifact = artifact;
      if (historyEntry) {
        stage.artifactHistory = [...(stage.artifactHistory ?? []), { ...historyEntry, revision: stage.revision }];
      }
      this.transitionGate(next, stage, 'pending_review');
    });
  }

  reopen(spec: SpecFile, stageId: StageId, reason: string): SpecFile {
    if (spec.execution.status === 'paused') throw new Error('Resume execution before reopening a stage.');
    if (!reason.trim()) throw new Error('A non-empty rework reason is required.');
    if (!this.stage(spec, stageId).artifact) throw new Error(`Stage "${stageId}" has not started.`);
    if (STAGE_IDS.indexOf(stageId) > STAGE_IDS.indexOf(spec.currentStageId)) throw new Error('Stage has not been reached.');
    if (spec.stages.slice(STAGE_IDS.indexOf(stageId)).some((stage) => stage.activeCheck)) throw new Error('A downstream check is running. Wait for completion or recover the interrupted run before rework.');
    if (spec.stages.slice(STAGE_IDS.indexOf(stageId)).some((stage) => stage.subtasks?.some((task) => task.status === 'running'))) throw new Error('Release running task claims before rework.');
    const next = structuredClone(spec);
    const index = STAGE_IDS.indexOf(stageId);
    for (const stage of next.stages.slice(index)) {
      if (stage.skipped) continue;
      stage.stale = true;
      stage.staleReason = reason.trim();
      stage.evidence = undefined;
      stage.activeCheck = undefined;
      stage.aiStatus = stage.id === stageId ? 'in_progress' : 'not_started';
      stage.gate.approvedRevision = undefined;
      stage.gate.actor = undefined;
      stage.gate.comment = stage.id === stageId ? reason.trim() : undefined;
      this.transitionGate(next, stage, stage.id === stageId ? 'needs_revision' : 'not_ready');
      stage.subtasks?.forEach((task) => { task.completed = false; task.status = 'pending'; task.claimId = undefined; task.attempt++; });
    }
    next.reworkHistory.push({ stageId, reason: reason.trim(), at: now() });
    next.currentStageId = stageId;
    next.execution.error = undefined;
    next.updatedAt = now();
    return next;
  }

  approve(spec: SpecFile, stageId: StageId, expectedRevision?: number, actor: 'human' | 'policy' = 'human'): SpecFile {
    this.assertReviewable(spec, stageId);
    if (stageId === 'test' || stageId === 'build') assertEvidence(this.stage(spec, stageId).evidence, stageId);
    if (expectedRevision !== undefined && this.stage(spec, stageId).revision !== expectedRevision) {
      throw new Error('Artifact revision changed. Refresh before reviewing.');
    }
    return this.mutateStage(spec, stageId, (next, stage) => {
      stage.gate.approvedRevision = stage.revision;
      stage.gate.actor = actor;
      stage.gate.reviewedAt = now();
      stage.gate.comment = actor === 'policy' ? 'Low-risk opted-in check policy: passing platform execution evidence.' : undefined;
      this.transitionGate(next, stage, 'approved');
    });
  }

  reject(spec: SpecFile, stageId: StageId, comment: string, expectedRevision?: number): SpecFile {
    this.assertReviewable(spec, stageId, expectedRevision);
    return this.mutateStage(spec, stageId, (next, stage) => {
      stage.gate.comment = comment;
      stage.gate.reviewedAt = now();
      stage.aiStatus = 'in_progress';
      this.transitionGate(next, stage, 'rejected');
    });
  }

  /**
   * Third verdict: the reviewer wants changes but considers this a minor
   * revision rather than an outright rejection. aiStatus → in_progress so
   * Claude can re-record; gate → needs_revision (advance still refused).
   */
  requestRevision(spec: SpecFile, stageId: StageId, comment: string, expectedRevision?: number): SpecFile {
    this.assertReviewable(spec, stageId, expectedRevision);
    return this.mutateStage(spec, stageId, (next, stage) => {
      stage.gate.comment = comment;
      stage.gate.reviewedAt = now();
      stage.aiStatus = 'in_progress';
      this.transitionGate(next, stage, 'needs_revision');
    });
  }

  /** Throws GateNotApprovedError if the current gate isn't approved. */
  advance(spec: SpecFile, stageId: StageId): SpecFile {
    const stage = this.stage(spec, stageId);
    if (stage.gate.status !== 'approved') {
      throw new GateNotApprovedError(stageId, stage.gate.status);
    }
    if (stage.stale || stage.gate.approvedRevision !== stage.revision) throw new Error('Approval revision is no longer valid. Reopen and review this stage.');
    if (STAGE_IDS.indexOf(stageId) < STAGE_IDS.indexOf(spec.currentStageId)) return spec;
    this.assertCurrent(spec, stageId);

    // Develop stage: all subtasks must be completed before advancing.
    if (stageId === 'develop') {
      const tasks = stage.subtasks ?? [];
      if (tasks.length === 0) {
        throw new Error(
          'Cannot advance stage "develop": no subtasks registered. ' +
          'Call set_develop_subtasks to register the implementation plan before advancing.'
        );
      }
      const incomplete = tasks.filter((t) => !t.completed);
      if (incomplete.length > 0) {
        throw new Error(
          `Cannot advance stage "develop": ${incomplete.length} subtask(s) not yet completed: ` +
          incomplete.map((t) => `"${t.description.slice(0, 60)}"` ).join(', ') + '. ' +
          'Complete all subtasks (log_implementation + toggle_subtask) before advancing.'
        );
      }
    }

    if (stageId === 'test' || stageId === 'build') assertEvidence(stage.evidence, stageId);

    const index = STAGE_IDS.indexOf(stageId);
    if (index === STAGE_IDS.length - 1) {
      throw new Error(`Cannot advance: "${stageId}" is the final stage.`);
    }
    const next = structuredClone(spec);
    const nextStage = next.stages.slice(index + 1).find((stage) => !stage.skipped)!;
    next.currentStageId = nextStage.id;
    // Opening the next stage: an auto stage is ready for AI, a stub stays stubbed.
    nextStage.aiStatus = nextStage.aiCapability === 'stub' ? 'stubbed' : 'not_started';
    nextStage.gate.status = 'not_ready';
    next.updatedAt = now();
    return next;
  }

  /* ---- subtasks (Phase 3) ---- */

  /**
   * Replace the DEVELOP subtask list wholesale. Assigns fresh UUIDs, resets
   * completed to false. Updates derived aiStatus.
   */
  setSubtasks(
    spec: SpecFile,
    inputs: SubtaskInput[],
    stageId: StageId = 'develop'
  ): SpecFile {
    if (stageId !== 'develop') {
      throw new Error(`setSubtasks is only valid for the develop stage, got "${stageId}"`);
    }
    this.assertCurrent(spec, stageId);
    for (const task of inputs) {
      if (task.requirementRef && !spec.acceptanceCriteria.some((criterion) => criterion.id === task.requirementRef)) throw new Error('Unknown acceptance criterion: ' + task.requirementRef);
    }
    return this.mutateStage(spec, stageId, (next, stage) => {
      if (stage.subtasks?.some((task) => task.status === 'running')) throw new Error('Release running tasks before replacing the plan.');
      stage.subtasks = inputs.map((t) => ({
        id: t.id ?? randomUUID(),
        description: t.description,
        completed: false,
        prompt: t.prompt,
        requirementRef: t.requirementRef,
        testRefs: t.testRefs ?? [],
        leverage: t.leverage,
        dependsOn: t.dependsOn ?? [],
        files: t.files ?? [],
        status: 'pending',
        attempt: 0,
      }));
      validateTasks(stage.subtasks);
      // Task drafts do not supersede an artifact until one has been submitted.
      // Once it exists, changing tasks must invalidate its review token.
      if (stage.artifact) stage.revision++;
      stage.gate.approvedRevision = undefined;
      this.transitionGate(next, stage, 'not_ready');
      stage.stale = !!stage.artifact;
      stage.staleReason = stage.artifact ? 'Implementation plan changed; submit it for review.' : undefined;
      this.deriveAiStatus(stage);
    });
  }

  /** Toggle a single subtask's completed flag; updates derived aiStatus. */
  toggleSubtask(spec: SpecFile, subtaskId: string): SpecFile {
    const task = this.stage(spec, 'develop').subtasks?.find((task) => task.id === subtaskId);
    if (!task) throw new Error('Unknown subtask id: ' + subtaskId);
    return this.setSubtaskCompleted(spec, subtaskId, !task.completed);
  }

  setSubtaskCompleted(spec: SpecFile, subtaskId: string, completed: boolean, claimId?: string): SpecFile {
    this.assertImplementation(spec);
    return this.mutateStage(spec, 'develop', (_next, stage) => {
      const task = stage.subtasks?.find((task) => task.id === subtaskId);
      if (!task) throw new Error('Unknown subtask id: ' + subtaskId);
      if ((task.status === 'running' || claimId) && task.claimId !== claimId) throw new Error('Current task claimId is required.');
      if (task.completed === completed) return;
      if (completed) {
        if (!task.dependsOn.every((id) => stage.subtasks?.some((dependency) => dependency.id === id && dependency.completed))) throw new Error('Task dependency is not complete.');
        task.completed = true; task.status = 'done';
      } else resetTaskAndDependents(stage.subtasks!, subtaskId);
      this.deriveAiStatus(stage);
    });
  }

  claimSubtask(spec: SpecFile, subtaskId: string): SpecFile {
    this.assertImplementation(spec);
    return this.mutateStage(spec, 'develop', (_next, stage) => {
      const task = stage.subtasks?.find((task) => task.id === subtaskId);
      if (!task) throw new Error('Unknown subtask id: ' + subtaskId);
      if (task.completed || task.status === 'running') throw new Error('Task is already completed or claimed.');
      if (!task.dependsOn.every((id) => stage.subtasks?.some((dependency) => dependency.id === id && dependency.completed))) throw new Error('Task dependency is not complete.');
      if (stage.subtasks?.some((other) => other.status === 'running' && filesConflict(task, other))) throw new Error('Task files conflict with running work.');
      task.status = 'running'; task.claimId = randomUUID();
    });
  }

  releaseSubtask(spec: SpecFile, subtaskId: string, claimId: string): SpecFile {
    this.assertImplementation(spec);
    return this.mutateStage(spec, 'develop', (_next, stage) => {
      const task = stage.subtasks?.find((task) => task.id === subtaskId);
      if (!task || task.status !== 'running' || task.claimId !== claimId) throw new Error('Current running task claimId is required.');
      resetTaskAndDependents(stage.subtasks!, subtaskId);
    });
  }

  /* ---- internals ---- */

  assertCurrent(spec: SpecFile, stageId: StageId, allowPaused = false): void {
    if (!allowPaused && spec.execution.status === 'paused') throw new Error('Execution is paused. Resume before continuing.');
    if (this.stage(spec, stageId).skipped) throw new Error('Stage is skipped by the workflow template.');
    if (spec.currentStageId !== stageId) throw new Error(`Current stage is "${spec.currentStageId}", cannot mutate "${stageId}".`);
    for (const stage of spec.stages.slice(0, STAGE_IDS.indexOf(stageId))) {
      if (stage.skipped) continue;
      if (stage.stale || stage.gate.status !== 'approved' || stage.gate.approvedRevision !== stage.revision) {
        throw new Error(`Upstream stage "${stage.id}" needs valid approval first.`);
      }
    }
  }

  assertImplementation(spec: SpecFile): void {
    this.assertCurrent(spec, 'develop');
    const stage = this.stage(spec, 'develop');
    if (stage.stale || stage.gate.status !== 'approved' || stage.gate.approvedRevision !== stage.revision) {
      throw new Error('Implementation requires an approved current plan revision.');
    }
  }

  private assertReviewable(spec: SpecFile, stageId: StageId, expectedRevision?: number): void {
    this.assertCurrent(spec, stageId, true);
    const stage = this.stage(spec, stageId);
    if (expectedRevision !== undefined && expectedRevision !== stage.revision) throw new Error('Artifact revision changed. Refresh before reviewing.');
    if (stage.gate.status !== 'pending_review' || !stage.artifact || stage.stale) {
      throw new Error('Only a non-stale artifact with pending_review status can be reviewed.');
    }
  }

  private stage(spec: SpecFile, stageId: StageId): Stage {
    const stage = spec.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Unknown stage: ${stageId}`);
    return stage;
  }

  private mutateStage(
    spec: SpecFile,
    stageId: StageId,
    fn: (next: SpecFile, stage: Stage) => void
  ): SpecFile {
    const next = structuredClone(spec);
    const stage = next.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Unknown stage: ${stageId}`);
    fn(next, stage);
    next.updatedAt = now();
    return next;
  }

  private transitionGate(spec: SpecFile, stage: Stage, to: GateStatus): void {
    const from = stage.gate.status;
    stage.gate.status = to;
    spec.gateHistory.push({
      stageId: stage.id,
      revision: stage.revision,
      from,
      to,
      comment: stage.gate.comment,
      actor: stage.gate.actor,
      at: now(),
    });
  }

  /**
   * Derive DEVELOP aiStatus from the subtask list. Only runs when the stage is
   * not stubbed (aiCapability = auto). Keeps gate logic unchanged.
   */
  private deriveAiStatus(stage: Stage): void {
    if (stage.aiCapability === 'stub') return;
    const tasks = stage.subtasks ?? [];
    if (tasks.length === 0) return;
    stage.aiStatus = tasks.every((t) => t.completed) ? 'done' : 'in_progress';
  }
}
