import { useNavigate } from 'react-router-dom';
import { currentStageId, GATE_STYLES } from '../lib/stage';
import { STAGE_LABELS, type SpecFile } from '../types';
import { StageDot } from './StageTimeline';

export function Board({ repoId, specs }: { repoId: string | null; specs: SpecFile[] }) {
  if (!repoId) {
    return (
      <div className="glass rounded-2xl flex-1 grid place-items-center text-slate-500">
        Add or select a repository to begin.
      </div>
    );
  }
  if (specs.length === 0) {
    return (
      <div className="glass rounded-2xl flex-1 grid place-items-center text-slate-500 text-sm">
        No specs yet — create one above.
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto flex flex-col gap-2">
      {specs.map((spec) => (
        <SpecRow key={spec.ticketId} repoId={repoId} spec={spec} />
      ))}
    </div>
  );
}

/**
 * Compact, always-expanded board row. Clicking the row body navigates to the
 * spec detail page (defaults to the current stage). Shows the mini dot timeline,
 * the active stage label, and its gate status.
 */
function SpecRow({ repoId, spec }: { repoId: string; spec: SpecFile }) {
  const navigate = useNavigate();

  const activeStageId = currentStageId(spec);
  const activeStage = spec.stages.find((s) => s.id === activeStageId)!;
  const hasPending = spec.stages.some((s) => s.gate.status === 'pending_review');

  const detailPath = `/repos/${repoId}/specs/${spec.ticketId}`;

  return (
    <div
      onClick={() => navigate(detailPath)}
      className={`glass rounded-2xl overflow-hidden transition-all cursor-pointer hover:bg-blue-50 ${hasPending ? 'border border-amber-300' : 'border border-transparent'}`}
    >
      <div className="w-full flex items-center gap-3 px-4 py-3 text-left">
        <span className="font-semibold text-sm shrink-0 w-28 truncate">{spec.ticketId}</span>

        <span className="text-sm text-gray-800 truncate flex-1 min-w-0">{spec.title}</span>

        {/* status labels: active stage · gate status */}
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className="text-[11px] rounded-full px-2 py-0.5 bg-blue-50 text-blue-700 font-medium">
            {STAGE_LABELS[activeStageId]}
          </span>
          <span
            className={`text-[11px] rounded px-2 py-0.5 ${GATE_STYLES[activeStage.gate.status]}`}
            title="Gate status"
          >
            {activeStage.gate.status.replace(/_/g, ' ')}
          </span>
        </div>

        {/* mini timeline — dots only, rightmost */}
        <div className="hidden md:flex items-center gap-1 shrink-0 ml-1">
          {spec.stages.map((s) => (
            <StageDot key={s.id} stage={s} active={s.id === activeStageId} />
          ))}
        </div>
      </div>
    </div>
  );
}
