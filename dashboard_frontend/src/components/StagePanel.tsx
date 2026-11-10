import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { AI_STATUS_STYLES, GATE_STYLES } from '../lib/stage';
import {
  STAGE_LABELS,
  type Artifact,
  type DeployChecklistArtifact,
  type OpsReportArtifact,
  type RequirementsData,
  type SpecFile,
  type Stage,
} from '../types';
import { DeployChecklistView } from './DeployChecklistView';
import { DevelopSubtasks } from './DevelopSubtasks';
import { OpsReportView } from './OpsReportView';
import { RequirementsView } from './RequirementsView';

/**
 * Per-stage display panel for the detail page. Fetches the stage's LATEST
 * artifact and renders a stage-specific view. Does NOT render approval buttons —
 * those live in the detail page's fixed bottom bar.
 */
export function StagePanel({
  repoId,
  ticketId,
  stage,
  spec,
  onReviewReady,
}: {
  repoId: string;
  ticketId: string;
  stage: Stage;
  spec: SpecFile;
  onReviewReady?: (review: { stageId: Stage['id']; revision: number } | null) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [data, setData] = useState<RequirementsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Refetch when the stage changes, or when it re-generates (aiStatus / gate flips).
  useEffect(() => {
    let alive = true;
    setLoading(true);
    onReviewReady?.(null);
    setErr(null);
    api
      .getArtifact(repoId, ticketId, stage.id)
      .then((res) => {
        if (!alive) return;
        setContent(res.content);
        setArtifact(res.artifact);
        setData(res.data ?? null);
        onReviewReady?.({ stageId: stage.id, revision: res.revision });
      })
      .catch((e) => {
        if (!alive) return;
        // 404 = no artifact generated yet; treat as empty, not an error.
        setContent(null);
        setArtifact(null);
        setData(null);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [repoId, ticketId, stage.id, stage.aiStatus, stage.gate.status, stage.revision, stage.stale, onReviewReady]);

  const markdownMetrics = artifact?.kind === 'markdown' ? artifact.metrics : undefined;

  return (
    <div className="glass rounded-2xl flex flex-col gap-4 p-5 min-h-full">
      {/* header: stage label + aiStatus + gateStatus + artifact kind + comment */}
      <div className="flex items-center gap-2 flex-wrap border-b border-blue-100 pb-3">
        <span className="font-semibold text-sm">{STAGE_LABELS[stage.id]}</span>
        <span
          className={`text-[11px] rounded-full px-2 py-0.5 ${AI_STATUS_STYLES[stage.aiStatus]}`}
          title="AI status"
        >
          AI: {stage.aiStatus.replace(/_/g, ' ')}
        </span>
        <span
          className={`text-[11px] rounded-full px-2 py-0.5 ${GATE_STYLES[stage.gate.status]}`}
          title="Gate status"
        >
          Gate: {stage.gate.status.replace(/_/g, ' ')}
        </span>
        {artifact && (
          <span className="text-[10px] rounded-full bg-blue-50 px-2 py-0.5 text-slate-500">
            {artifact.kind}
          </span>
        )}
        {(stage.gate.status === 'rejected' || stage.gate.status === 'needs_revision') &&
          stage.gate.comment && (
            <span className="text-[11px] text-red-600 italic ml-auto" title={stage.gate.comment}>
              "{stage.gate.comment}"
            </span>
          )}
      </div>

      {/* body */}
      <p className="text-xs text-slate-500">Artifact revision: {stage.revision} {stage.gate.actor === 'policy' ? '· approved by check policy' : ''}</p>
      {stage.skipped && <p className="rounded-lg bg-slate-100 p-3 text-sm">Skipped: {stage.skipReason}</p>}
      {stage.stale && stage.artifact && <p className="rounded-lg bg-orange-100 p-3 text-sm" role="status">Outdated artifact: {stage.staleReason}. This content is retained for reference and requires rework.</p>}
      {stage.evidence && (
        <div className="rounded-lg bg-blue-50 p-3 text-sm flex flex-col gap-1">
          <strong>Recorded execution evidence</strong>
          <span>Exit code: {stage.evidence.exitCode ?? 'terminated'} · {stage.evidence.timedOut ? 'timed out' : stage.evidence.finishedAt}</span>
          {stage.evidence.coverage !== undefined && <span>Measured line coverage: {Math.round(stage.evidence.coverage * 100)}%</span>}
          <span className="text-xs break-all">Run: {stage.evidence.runId} · Output: {stage.evidence.outputPath}</span>
          {stage.evidence.codeChanged && <span className="text-red-600">Code changed during execution; run again.</span>}
        </div>
      )}
      <div className="flex-1">
        {loading && <p className="text-sm text-slate-500">Loading…</p>}
        {err && <p className="text-sm text-red-600">{err}</p>}
        {!loading && !err && content === null && (
          <div className="grid place-items-center py-16 text-center text-slate-500 text-sm">
            <div>
              <p>Nothing generated for this stage yet.</p>
              <p className="text-[11px] mt-1 opacity-70">
                Claude writes the artifact here once it runs this stage.
              </p>
            </div>
          </div>
        )}

        {!loading && !err && content !== null && (
          <StageBody
            stageId={stage.id}
            content={content}
            artifact={artifact}
            data={data}
            metrics={markdownMetrics}
            repoId={repoId}
            spec={spec}
          />
        )}
      </div>
    </div>
  );
}

function StageBody({
  stageId,
  content,
  artifact,
  data,
  metrics,
  repoId,
  spec,
}: {
  stageId: Stage['id'];
  content: string;
  artifact: Artifact | null;
  data: RequirementsData | null;
  metrics?: { stageCoverage?: number; buildSuccess?: boolean; cycleTimeMs?: number };
  repoId: string;
  spec: SpecFile;
}) {
  // Structured artifact kinds take priority over the stage switch.
  if (artifact?.kind === 'deploy-checklist') {
    return <DeployChecklistView artifact={artifact as DeployChecklistArtifact} content={content} />;
  }
  if (artifact?.kind === 'ops-report') {
    return <OpsReportView artifact={artifact as OpsReportArtifact} content={content} />;
  }
  // Requirements: render the rich view when the structured sidecar is present;
  // fall back to markdown for older markdown-only requirements artifacts.
  if (artifact?.kind === 'requirements' && data) {
    return <RequirementsView data={data} content={content} />;
  }

  switch (stageId) {
    case 'develop':
      return (
        <div className="flex flex-col gap-4">
          <Markdown content={content} />
          <DevelopSubtasks repoId={repoId} spec={spec} />
        </div>
      );

    case 'test':
      return (
        <div className="flex flex-col gap-4">
          {metrics?.stageCoverage !== undefined && (
            <StatCard
              value={`${Math.round(metrics.stageCoverage * 100)}%`}
              label="stage coverage"
              tone={metrics.stageCoverage >= 0.8 ? 'good' : 'warn'}
            />
          )}
          <Markdown content={content} />
        </div>
      );

    case 'build':
      // Record-display style: build result as a single record, no advance-gate framing.
      return (
        <div className="flex flex-col gap-4">
          {metrics?.buildSuccess !== undefined && (
            <StatCard
              value={metrics.buildSuccess ? '✓ passed' : '✗ failed'}
              label="build result"
              tone={metrics.buildSuccess ? 'good' : 'bad'}
            />
          )}
          <Markdown content={content} />
        </div>
      );

    case 'spec':
    case 'requirements':
    case 'design':
    case 'deploy':
    case 'ops':
    default:
      return <Markdown content={content} />;
  }
}

function Markdown({ content }: { content: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function StatCard({
  value,
  label,
  tone,
}: {
  value: string;
  label: string;
  tone: 'good' | 'warn' | 'bad';
}) {
  const toneCls =
    tone === 'good'
      ? 'text-emerald-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : 'text-red-600';
  return (
    <div className="inline-flex items-center gap-3 rounded-xl bg-blue-50 px-4 py-3 w-fit">
      <span className={`text-2xl font-bold ${toneCls}`}>{value}</span>
      <span className="text-[11px] text-slate-500 uppercase tracking-wide">{label}</span>
    </div>
  );
}
