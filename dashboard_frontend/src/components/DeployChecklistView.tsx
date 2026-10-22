import ReactMarkdown from 'react-markdown';
import type { DeployChecklistArtifact } from '../types';

/** Render a deploy-checklist artifact: shows each item with governance flags. */
export function DeployChecklistView({
  artifact,
  content,
}: {
  artifact: DeployChecklistArtifact;
  content: string;
}) {
  const GOVERNANCE_BADGE: Record<string, string> = {
    pci: 'bg-yellow-400/20 text-yellow-200',
    gdpr: 'bg-purple-400/20 text-purple-200',
    none: '',
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">Status:</span>
        <span className="text-xs rounded-full bg-white/10 px-2 py-0.5">{artifact.status}</span>
        {artifact.rollbackCriteria && (
          <span className="text-xs text-amber-600/80 italic ml-auto">
            ↩ {artifact.rollbackCriteria}
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {artifact.items.map((item) => (
          <li key={item.id} className="flex items-start gap-2 rounded-lg bg-blue-50 px-3 py-2">
            <span
              className={`mt-0.5 w-4 h-4 rounded shrink-0 flex items-center justify-center text-[10px] ${item.checked ? 'joule-gradient text-white' : 'border border-white/20'}`}
            >
              {item.checked ? '✓' : ''}
            </span>
            <span className={`text-sm flex-1 ${item.checked ? 'line-through text-slate-500' : ''}`}>
              {item.description}
            </span>
            {item.governanceFlag !== 'none' && (
              <span
                className={`text-[10px] rounded-full px-1.5 py-0.5 shrink-0 ${GOVERNANCE_BADGE[item.governanceFlag]}`}
              >
                {item.governanceFlag.toUpperCase()}
              </span>
            )}
          </li>
        ))}
      </ul>
      {content && (
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer">Raw markdown</summary>
          <div className="md-body mt-2">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        </details>
      )}
    </div>
  );
}
