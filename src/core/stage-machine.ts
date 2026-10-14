import {
  STAGE_IDS,
  SCHEMA_VERSION,
  type SpecFile,
  type Stage,
  type StageId,
  type AiCapability,
  type GateStatus,
} from './schemas.js';

/** Thrown when advance_stage is called but the current gate is not approved. */
export class GateNotApprovedError extends Error {
  readonly code = 'GATE_NOT_APPROVED';
  constructor(stageId: StageId, actual: GateStatus) {
    super(`Cannot advance stage "${stageId}": gate is "${actual}", must be "approved".`);
    this.name = 'GateNotApprovedError';
  }
}

/** v1 automation map: only spec + requirements are really wired. */
const AUTO_STAGES: ReadonlySet<StageId> = new Set<StageId>(['spec', 'requirements']);

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

  recordAiOutput(spec: SpecFile, stageId: StageId, artifactPath: string): SpecFile {
    return this.mutateStage(spec, stageId, (next, stage) => {
      stage.aiStatus = 'done';
      stage.artifactPath = artifactPath;
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
}
