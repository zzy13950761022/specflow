import type { SpecFile, GateHistoryEntry } from './schemas.js';

/** Preserve historical completion, without issuing new approvals or check evidence. */
function completionRecord(spec: SpecFile): GateHistoryEntry | undefined {
  if (spec.reworkHistory.length || spec.stages.some((stage) => stage.stale || stage.skipped || !stage.artifact || stage.activeCheck || !['done', 'stubbed'].includes(stage.aiStatus))) return;
  const oldHistory = spec.gateHistory.filter((entry) => entry.revision === undefined);
  const completed = oldHistory.at(-1);
  if (completed?.stageId !== 'ops' || completed.to !== 'approved' || !Number.isFinite(Date.parse(completed.at))) return;
  for (const stage of spec.stages) {
    const lastDecision = oldHistory.filter((entry) => entry.stageId === stage.id).at(-1);
    if (lastDecision?.to !== 'approved' || !Number.isFinite(Date.parse(lastDecision.at)) || Date.parse(lastDecision.at) > Date.parse(completed.at)) return;
    if (stage.revision > 1 || stage.artifactHistory?.some((entry) => (entry.revision ?? 1) > 1 || !Number.isFinite(Date.parse(entry.at)) || Date.parse(entry.at) > Date.parse(completed.at))) return;
    if (stage.subtasks?.some((task) => task.status === 'running' || task.claimId)) return;
  }
  if (spec.schemaVersion === 2) {
    if (spec.stages.some((stage) => stage.gate.status !== 'approved' || stage.subtasks?.some((task) => !task.completed))) return;
  } else if (spec.schemaVersion === 3) {
    // Only the recognizable old migration reset is repairable. New work must use rework.
    if (spec.currentStageId !== 'spec' || spec.workflow.workflowKind !== 'standard' || !['ready', 'waiting_review'].includes(spec.execution.status) || spec.execution.error) return;
    if (spec.stages.some((stage) => stage.revision !== 1 || !['pending_review', 'approved'].includes(stage.gate.status) || stage.subtasks?.some((task) => task.attempt !== 1 || task.completed || task.status !== 'pending'))) return;
    if (spec.gateHistory.some((entry) => entry.revision !== undefined && !(entry.stageId === 'spec' && entry.revision === 1 && entry.to === 'approved'))) return;
  } else return;
  return completed;
}

export function isCompletedLegacySpec(spec: SpecFile): boolean {
  return spec.schemaVersion === 2 && !!completionRecord(spec);
}

/** Explicit, conservative repair for a completed v2 ticket or its old migration reset. */
export function restoreLegacyCompletion(spec: SpecFile, restoredAt = new Date().toISOString()): SpecFile {
  if (spec.legacyCompletion && spec.currentStageId === 'ops' && spec.execution.status === 'completed') return spec;
  const completed = completionRecord(spec);
  if (!completed) throw new Error('Ticket does not match an unchanged, completed legacy workflow.');
  const next = structuredClone(spec);
  next.schemaVersion = 3;
  next.currentStageId = 'ops';
  next.legacyCompletion = { sourceSchemaVersion: 2, completedAt: completed.at, restoredAt };
  next.execution = { status: 'completed', retryCount: next.execution.retryCount, lastSuccessfulStep: 'legacy_completion' };
  for (const stage of next.stages) {
    const decision = next.gateHistory.filter((entry) => entry.stageId === stage.id && entry.revision === undefined).at(-1)!;
    stage.revision = Math.max(stage.revision, 1);
    stage.gate = { ...stage.gate, status: 'approved', reviewedAt: decision.at, approvedRevision: stage.revision };
    stage.subtasks?.forEach((task) => { task.completed = true; task.status = 'done'; });
  }
  return next;
}
