import type { AiStatus, GateStatus, SpecFile, StageId, TemplateSource } from '../types';

/**
 * The "current" stage of a spec: the first stage whose gate isn't approved yet,
 * OR that's still being worked on (aiStatus != done/stubbed) — develop Phase B
 * can still be in progress even after the Phase A gate is approved.
 */
export function currentStageId(spec: SpecFile): StageId {
  for (const stage of spec.stages) {
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
  not_ready: 'bg-white/10 text-joule-muted',
  pending_review: 'bg-amber-400/20 text-amber-200',
  approved: 'bg-emerald-400/20 text-emerald-200',
  rejected: 'bg-red-400/20 text-red-200',
  needs_revision: 'bg-orange-400/20 text-orange-200',
};

export const AI_STATUS_STYLES: Record<AiStatus, string> = {
  not_started: 'bg-white/10 text-joule-muted',
  in_progress: 'bg-joule-blue/20 text-joule-blue',
  done: 'bg-emerald-400/20 text-emerald-200',
  stubbed: 'bg-white/10 text-joule-muted',
};

export const SOURCE_BADGE: Record<TemplateSource, { label: string; cls: string }> = {
  'repo-curated': { label: 'curated', cls: 'bg-emerald-400/20 text-emerald-200' },
  'repo-draft': { label: 'draft', cls: 'bg-amber-400/20 text-amber-200' },
  'blueprint-default': { label: 'blueprint', cls: 'bg-white/10 text-joule-muted' },
};
