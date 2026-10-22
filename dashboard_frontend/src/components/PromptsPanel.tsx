import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { SOURCE_BADGE } from '../lib/stage';
import { STAGE_LABELS, type StageId, type TemplateSummary } from '../types';

export function PromptsPanel({
  repoId,
  onError,
}: {
  repoId: string;
  onError: (e: string) => void;
}) {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [expanded, setExpanded] = useState<StageId | null>(null);
  const [curating, setCurating] = useState<StageId | null>(null);

  const load = useCallback(async () => {
    try {
      setTemplates(await api.listTemplates(repoId));
    } catch (e) {
      onError(String((e as Error).message));
    }
  }, [repoId, onError]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="glass rounded-2xl flex-1 flex flex-col gap-0 overflow-auto">
      <div className="px-5 pt-4 pb-2 flex items-center gap-2">
        <h2 className="text-xs uppercase tracking-widest text-slate-500 font-semibold">
          Prompt Templates
        </h2>
        <span className="text-[11px] text-slate-500 ml-auto">
          Curate drafts after reviewing — curated templates are preferred over blueprint defaults
        </span>
      </div>
      {templates.map((tpl) => {
        const badge = SOURCE_BADGE[tpl.source];
        const isExpanded = expanded === tpl.stageId;
        return (
          <div key={tpl.stageId} className="border-t border-gray-200">
            <div
              className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-white/3 transition"
              onClick={() => setExpanded(isExpanded ? null : tpl.stageId)}
            >
              <span className="text-sm font-medium w-28">{STAGE_LABELS[tpl.stageId]}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${badge.cls}`}>
                {badge.label}
              </span>
              {tpl.source === 'repo-draft' && (
                <button
                  disabled={curating === tpl.stageId}
                  onClick={async (e) => {
                    e.stopPropagation();
                    setCurating(tpl.stageId);
                    try {
                      await api.markTemplateCurated(repoId, tpl.stageId);
                      await load();
                    } catch (err) {
                      onError(String((err as Error).message));
                    } finally {
                      setCurating(null);
                    }
                  }}
                  className="ml-auto rounded-lg joule-gradient text-white text-[11px] px-3 py-1 disabled:opacity-60"
                >
                  {curating === tpl.stageId ? 'Marking…' : 'Mark curated'}
                </button>
              )}
              <span className="ml-auto text-slate-500 text-xs">{isExpanded ? '▲' : '▼'}</span>
            </div>
            {isExpanded && (
              <pre className="mx-5 mb-3 rounded-xl bg-gray-100 border border-gray-200 px-4 py-3 text-[11px] text-gray-600 overflow-auto whitespace-pre-wrap max-h-64">
                {tpl.content}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
