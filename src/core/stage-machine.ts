import {
  STAGE_IDS,
  SCHEMA_VERSION,
  type SpecFile,
  type Stage,
  type StageId,
  type AiCapability,
  type GateStatus,
  type Artifact,
} from './schemas.js';
import { randomUUID } from 'crypto';

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
  createSpec(input: { ticketId: string; title: string }): SpecFile {
    const stages: Stage[] = STAGE_IDS.map((id) => {
      const capability: AiCapability = AUTO_STAGES.has(id) ? 'auto' : 'stub';
      const stage: Stage = {
        id,
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
      specPath: `specs/${input.ticketId}-${slugify(input.title)}.md`,
      stages,
      gateHistory: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  recordAiOutput(
    spec: SpecFile,
    stageId: StageId,
    artifact: Artifact,
    historyEntry?: { path: string; at: string }
  ): SpecFile {
    return this.mutateStage(spec, stageId, (next, stage) => {
      stage.aiStatus = 'done';
      stage.artifact = artifact;
      if (historyEntry) {
        stage.artifactHistory = [...(stage.artifactHistory ?? []), historyEntry];
      }
      this.transitionGate(next, stage, 'pending_review');
    });
  }

  approve(spec: SpecFile, stageId: StageId): SpecFile {
    return this.mutateStage(spec, stageId, (next, stage) => {
      stage.gate.reviewedAt = now();
      stage.gate.comment = undefined;
      this.transitionGate(next, stage, 'approved');
    });
  }

  reject(spec: SpecFile, stageId: StageId, comment: string): SpecFile {
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
  requestRevision(spec: SpecFile, stageId: StageId, comment: string): SpecFile {
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
    const index = STAGE_IDS.indexOf(stageId);
    if (index === STAGE_IDS.length - 1) {
      throw new Error(`Cannot advance: "${stageId}" is the final stage.`);
    }
    const next = structuredClone(spec);
    const nextStage = next.stages[index + 1];
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
    inputs: Array<{ description: string; prompt?: string; requirementRef?: string }>,
    stageId: StageId = 'develop'
  ): SpecFile {
    if (stageId !== 'develop') {
      throw new Error(`setSubtasks is only valid for the develop stage, got "${stageId}"`);
    }
    return this.mutateStage(spec, stageId, (_next, stage) => {
      stage.subtasks = inputs.map((t) => ({
        id: randomUUID(),
        description: t.description,
        completed: false,
        prompt: t.prompt,
        requirementRef: t.requirementRef,
      }));
      this.deriveAiStatus(stage);
    });
  }

  /** Toggle a single subtask's completed flag; updates derived aiStatus. */
  toggleSubtask(spec: SpecFile, subtaskId: string): SpecFile {
    return this.mutateStage(spec, 'develop', (_next, stage) => {
      const task = (stage.subtasks ?? []).find((t) => t.id === subtaskId);
      if (!task) throw new Error(`Unknown subtask id: ${subtaskId}`);
      task.completed = !task.completed;
      this.deriveAiStatus(stage);
    });
  }

  /* ---- internals ---- */

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
      from,
      to,
      comment: stage.gate.comment,
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
