import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { GateActions } from '../components/GateActions';
import { StageTimeline } from '../components/StageTimeline';
import { StagePanel } from '../components/StagePanel';
import { WorkflowControls } from '../components/WorkflowControls';
import { useAppState } from '../context/AppContext';
import { readBoardFilters, writeBoardFilters } from '../lib/board';
import { currentStageId, GATE_STYLES } from '../lib/stage';
import { STAGE_IDS, type InlineAnnotation, type SpecFile, type StageId } from '../types';

export function SpecDetailPage() {
  const { repoId, ticketId } = useParams<{ repoId: string; ticketId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { specs, activeRepo, setActiveRepo, refreshSpecs } = useAppState();

  const [agentProfileId, setAgentProfileId] = useState('');
  const [coldSpec, setColdSpec] = useState<SpecFile | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [review, setReview] = useState<{ stageId: StageId; revision: number } | null>(null);
  const [annotations, setAnnotations] = useState<InlineAnnotation[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  // Ensure the shared store starts tracking this repo (WS + polling).
  useEffect(() => {
    if (repoId && repoId !== activeRepo) setActiveRepo(repoId);
  }, [repoId, activeRepo, setActiveRepo]);

  // Prefer the live spec from context; fall back to a cold fetch on deep link /
  // hard reload where the context list for this repo hasn't arrived yet.
  const liveSpec = (activeRepo === repoId ? specs : []).find((s) => s.ticketId === ticketId) ?? null;
  const spec = liveSpec ?? coldSpec;

  useEffect(() => {
    if (liveSpec || !repoId || !ticketId) return;
    let alive = true;
    api
      .getSpec(repoId, ticketId)
      .then((s) => alive && setColdSpec(s))
      .catch((e) => alive && setLoadErr(String((e as Error).message)));
    return () => {
      alive = false;
    };
  }, [liveSpec, repoId, ticketId]);

  const selectedStageId: StageId | null = spec
    ? ((searchParams.get('stage') as StageId | null) &&
      STAGE_IDS.includes(searchParams.get('stage') as StageId)
        ? (searchParams.get('stage') as StageId)
        : currentStageId(spec))
    : null;

  const boardSearch = writeBoardFilters(readBoardFilters(searchParams)).toString();
  const boardPath = '/' + (boardSearch ? '?' + boardSearch : '');
  const selectStage = (id: StageId) => { const next = new URLSearchParams(searchParams); next.set('stage', id); setSearchParams(next, { replace: true }); };

  // Reset the document scroll without moving the surrounding navigation.
  useEffect(() => {
    if (selectedStageId) panelRef.current?.scrollTo({ top: 0 });
  }, [selectedStageId]);

  // Keep annotation drafts scoped to one ticket, stage and artifact revision.
  useEffect(() => {
    setAnnotations([]);
  }, [repoId, ticketId, selectedStageId, spec?.stages.find((stage) => stage.id === selectedStageId)?.revision]);

  function handleAnnotationSave(a: InlineAnnotation) {
    setAnnotations((prev) => {
      const idx = prev.findIndex((x) => x.id === a.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = a;
        return next;
      }
      return [...prev, a];
    });
  }

  function handleAnnotationRemove(id: string) {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  }

  if (loadErr) {
    return (
      <div className="glass rounded-2xl flex-1 grid place-items-center text-red-300 text-sm">
        {loadErr} — <Link to={boardPath} className="underline ml-1">back to board</Link>
      </div>
    );
  }
  if (!spec || !selectedStageId || !repoId || !ticketId) {
    return (
      <div className="glass rounded-2xl flex-1 grid place-items-center text-slate-500 text-sm">
        Loading spec…
      </div>
    );
  }

  const activeStageId = currentStageId(spec);
  const selectedStage = spec.stages.find((s) => s.id === selectedStageId)!;

  return (
    <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
      {/* top: back link + title */}
      <div className="flex items-center gap-3 shrink-0 min-w-0">
        <Link
          to={boardPath}
          className="text-sm text-slate-500 hover:text-gray-800 rounded-lg px-2 py-1 bg-blue-50 shrink-0"
        >
          ← Board
        </Link>
        <span className="font-semibold text-sm shrink-0">{spec.ticketId}</span>
        <span className="text-sm text-slate-500 truncate" title={spec.title}>
          {spec.title}
        </span>
      </div>

      {/* top: timeline */}
      <WorkflowControls profileId={agentProfileId} onProfileChange={setAgentProfileId} repoId={repoId} spec={spec} stage={selectedStage} onDone={() => refreshSpecs(repoId)} />
      <div className="glass rounded-xl px-2 py-1 shrink-0 min-w-0">
        <StageTimeline
          spec={spec}
          activeStageId={activeStageId}
          selectedStageId={selectedStageId}
          onSelectStage={selectStage}
        />
      </div>

      {/* middle: scrollable stage panel */}
      <div ref={panelRef} role="region" aria-label="Stage content" tabIndex={0} className="flex-1 min-h-0 overflow-auto rounded-xl">
        <StagePanel
          key={repoId + ":" + ticketId + ":" + selectedStage.id + ":" + selectedStage.revision}
          onReviewReady={setReview}
          agentProfileId={agentProfileId}
          onDone={() => refreshSpecs(repoId)}
          repoId={repoId}
          ticketId={ticketId}
          stage={selectedStage}
          spec={spec}
          annotations={annotations}
          onAnnotationSave={handleAnnotationSave}
          onAnnotationRemove={handleAnnotationRemove}
        />
      </div>

      {/* bottom: fixed approval bar for the selected stage */}
      <div className="glass rounded-xl px-3 py-2 shrink-0 max-h-[35vh] overflow-auto">
        {selectedStage.gate.status === 'pending_review' && review?.stageId === selectedStage.id && review.revision === selectedStage.revision ? (
          <GateActions
            key={repoId + ":" + ticketId + ":" + selectedStage.id + ":" + review.revision}
            repoId={repoId}
            ticketId={ticketId}
            stageId={selectedStage.id}
            revision={review.revision}
            onDone={() => refreshSpecs(repoId)}
            annotations={annotations}
            onAnnotationRemove={handleAnnotationRemove}
          />
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span>Gate:</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${GATE_STYLES[selectedStage.gate.status]}`}>
              {selectedStage.gate.status.replace(/_/g, ' ')}
            </span>
            <span className="text-[11px] opacity-70">
              {selectedStage.gate.status === 'approved'
                ? 'This stage is approved.'
                : 'No review pending for this stage.'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
