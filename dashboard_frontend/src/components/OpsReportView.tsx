import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { OpsReportArtifact } from '../types';

/**
 * Render an ops-report artifact as a production-issue record (记录展示 style).
 * Surfaces the log-sanitization flag and any RCA / runbook pointers, but keeps a
 * neutral "record" tone rather than a blocking governance warning.
 */
export function OpsReportView({
  artifact,
  content,
}: {
  artifact: OpsReportArtifact;
  content: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-500">Log sanitization:</span>
        <span
          className={`text-xs font-semibold rounded-full px-2 py-0.5 ${artifact.logsSanitized ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}
        >
          {artifact.logsSanitized ? '✓ Sanitized' : 'Not sanitized'}
        </span>
      </div>
      {artifact.metrics && (
        <div className="grid grid-cols-3 gap-2">
          {artifact.metrics.stageCoverage !== undefined && (
            <div className="rounded-lg bg-blue-50 px-3 py-2 text-center">
              <div className="text-lg font-bold">{artifact.metrics.stageCoverage}%</div>
              <div className="text-[10px] text-slate-500">stage coverage</div>
            </div>
          )}
          {artifact.metrics.cycleTimeMs !== undefined && (
            <div className="rounded-lg bg-blue-50 px-3 py-2 text-center">
              <div className="text-lg font-bold">
                {Math.round(artifact.metrics.cycleTimeMs / 1000 / 60)}m
              </div>
              <div className="text-[10px] text-slate-500">cycle time</div>
            </div>
          )}
          {artifact.metrics.buildSuccess !== undefined && (
            <div className="rounded-lg bg-blue-50 px-3 py-2 text-center">
              <div
                className={`text-lg font-bold ${artifact.metrics.buildSuccess ? 'text-emerald-600' : 'text-red-600'}`}
              >
                {artifact.metrics.buildSuccess ? '✓' : '✗'}
              </div>
              <div className="text-[10px] text-slate-500">build</div>
            </div>
          )}
        </div>
      )}
      {(artifact.rcaPath || artifact.runbookPath) && (
        <div className="text-xs text-slate-500 flex flex-col gap-1">
          {artifact.rcaPath && <span>RCA: {artifact.rcaPath}</span>}
          {artifact.runbookPath && <span>Runbook: {artifact.runbookPath}</span>}
        </div>
      )}
      <div className="md-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}
