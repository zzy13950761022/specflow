import { STAGE_LABELS, type SpecFile, type Stage, type StageId } from '../types';

export function StageDot({ stage, active }: { stage: Stage; active: boolean }) {
  if (stage.skipped) return <span className="w-2 h-2 rounded-full border border-slate-300" title={stage.skipReason} />;
  const isApproved = stage.gate.status === 'approved';
  const isPending = stage.gate.status === 'pending_review';
  const isRejected = stage.gate.status === 'rejected' || stage.gate.status === 'needs_revision';

  const cls = isApproved
    ? 'bg-emerald-400'
    : isPending
      ? 'bg-amber-400 animate-pulse'
      : isRejected
        ? 'bg-red-400'
        : active
          ? 'bg-blue-500'
          : 'bg-slate-200';

  return <span className={`w-2 h-2 rounded-full ${cls}`} title={stage.id} />;
}

export function StageTimeline({
  spec,
  activeStageId,
  selectedStageId,
  onSelectStage,
}: {
  spec: SpecFile;
  activeStageId: StageId;
  selectedStageId: StageId;
  onSelectStage: (stageId: StageId) => void;
}) {
  return (
    <nav aria-label="Workflow stages" className="overflow-x-auto">
      <div className="flex gap-1 w-max min-w-full">
        {spec.stages.map((stage, index) => {
          const isSelected = stage.id === selectedStageId;
          const isActive = stage.id === activeStageId;
          const implementationPending = stage.id === 'develop' && stage.gate.status === 'approved' && !!stage.subtasks?.some(task => !task.completed || task.review?.status !== 'approved');
          const approved = stage.gate.status === 'approved' && !implementationPending;
          const rejected = stage.gate.status === 'rejected';
          const revision = stage.stale || stage.gate.status === 'needs_revision';
          const status = implementationPending ? 'implementation review incomplete' : stage.skipped ? 'skipped' : stage.stale ? 'outdated' : stage.gate.status.replaceAll('_', ' ');
          const symbol = stage.skipped ? '−' : revision ? '↩' : approved ? '✓' : rejected ? '✗' : stage.gate.status === 'pending_review' ? '…' : index + 1;
          return <button key={stage.id} onClick={() => onSelectStage(stage.id)}
            aria-label={'Select ' + STAGE_LABELS[stage.id]} aria-pressed={isSelected} aria-current={isActive ? 'step' : undefined}
            title={STAGE_LABELS[stage.id] + ': ' + status + (stage.gate.comment ? ' — ' + stage.gate.comment : '')}
            className={'flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-2 text-xs transition ' + (isSelected ? 'border-blue-300 bg-blue-50 text-blue-800 font-semibold' : 'border-transparent text-slate-500 hover:bg-blue-50')}>
            <span aria-hidden="true" className={approved ? 'text-emerald-600' : rejected || revision ? 'text-orange-600' : isActive ? 'text-blue-600' : 'text-slate-400'}>{symbol}</span>
            {STAGE_LABELS[stage.id]}
            {(stage.skipped || stage.stale) && <span className="text-[10px]">({status})</span>}
          </button>;
        })}
      </div>
    </nav>
  );
}
