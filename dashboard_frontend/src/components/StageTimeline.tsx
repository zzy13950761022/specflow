import { GATE_STYLES } from '../lib/stage';
import { STAGE_LABELS, type SpecFile, type Stage, type StageId } from '../types';

export function StageDot({ stage, active }: { stage: Stage; active: boolean }) {
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
    <div className="pt-3 overflow-x-auto">
      <div className="flex items-start min-w-max gap-0">
        {spec.stages.map((stage, i) => {
          const isApproved = stage.gate.status === 'approved';
          const isPending = stage.gate.status === 'pending_review';
          const isRejected = stage.gate.status === 'rejected';
          const isRevision = stage.gate.status === 'needs_revision';
          const isActive = stage.id === activeStageId;
          const isSelected = stage.id === selectedStageId;
          const isFuture = !isApproved && !isActive;
          const isLast = i === spec.stages.length - 1;

          const nodeColor = isApproved
            ? 'border-emerald-400 bg-emerald-50 text-emerald-600'
            : isPending
              ? 'border-amber-400 bg-amber-50 text-amber-600'
              : isRejected
                ? 'border-red-400 bg-red-50 text-red-600'
                : isRevision
                  ? 'border-orange-400 bg-orange-50 text-orange-600'
                  : isActive
                    ? 'border-blue-500 bg-blue-100 text-blue-600'
                    : 'border-slate-200 bg-white text-slate-400';

          const lineColor = isApproved ? 'bg-emerald-300' : 'bg-slate-200';

          return (
            <div key={stage.id} className="flex items-start">
              {/* node + label */}
              <div className="flex flex-col items-center w-20">
                <button
                  onClick={() => onSelectStage(stage.id)}
                  title={`Select ${STAGE_LABELS[stage.id]}`}
                  className={`w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold transition ${nodeColor} ${
                    isSelected ? 'ring-2 ring-blue-500 ring-offset-2 ring-offset-white' : ''
                  } hover:scale-110 cursor-pointer`}
                >
                  {isApproved ? '✓' : isRejected ? '✗' : isRevision ? '↩' : isPending ? '…' : i + 1}
                </button>
                <span
                  className={`text-[10px] mt-1 text-center leading-tight ${isFuture ? 'text-slate-400' : isSelected ? 'text-gray-800 font-semibold' : isActive ? 'text-gray-800' : 'text-slate-500'}`}
                >
                  {STAGE_LABELS[stage.id]}
                </span>
                {isActive && (
                  <span
                    className={`text-[10px] mt-0.5 rounded-full px-1.5 py-px text-center ${GATE_STYLES[stage.gate.status]}`}
                  >
                    {stage.gate.status.replace(/_/g, ' ')}
                  </span>
                )}
                {(isRejected || isRevision) && stage.gate.comment && (
                  <p
                    className="text-[10px] text-red-600/70 italic mt-0.5 text-center max-w-[72px] truncate"
                    title={stage.gate.comment}
                  >
                    "{stage.gate.comment}"
                  </p>
                )}
              </div>

              {/* connector line */}
              {!isLast && <div className={`w-8 h-0.5 mt-4 shrink-0 ${lineColor}`} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
