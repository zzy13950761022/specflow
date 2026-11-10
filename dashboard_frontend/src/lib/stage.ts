import type { AiStatus, GateStatus, SpecFile, StageId, TemplateSource } from '../types';

/**
 * The "current" stage of a spec: the first stage whose gate isn't approved yet,
 * OR that's still being worked on (aiStatus != done/stubbed) — develop Phase B
 * can still be in progress even after the Phase A gate is approved.
 */
export function currentStageId(spec: SpecFile): StageId {
  if (spec.currentStageId) return spec.currentStageId;
  for (const stage of spec.stages) {
    if (stage.skipped) continue;
    if (
      stage.gate.status !== 'approved' ||
      (stage.aiStatus !== 'done' && stage.aiStatus !== 'stubbed')
    ) {
      return stage.id;
    }
  }
  return spec.stages[spec.stages.length - 1].id;
}

export const GATE_STYLES: Record<GateStatus, string> = {
  not_ready: 'bg-gray-100 text-slate-500',
  pending_review: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
  needs_revision: 'bg-orange-100 text-orange-700',
};

export const AI_STATUS_STYLES: Record<AiStatus, string> = {
  not_started: 'bg-gray-100 text-slate-500',
  in_progress: 'bg-blue-100 text-blue-700',
  done: 'bg-emerald-100 text-emerald-700',
  stubbed: 'bg-gray-100 text-slate-500',
};

export const SOURCE_BADGE: Record<TemplateSource, { label: string; cls: string }> = {
  'repo-curated': { label: 'curated', cls: 'bg-emerald-100 text-emerald-700' },
  'repo-draft': { label: 'draft', cls: 'bg-amber-100 text-amber-700' },
  'blueprint-default': { label: 'blueprint', cls: 'bg-gray-100 text-slate-500' },
};
