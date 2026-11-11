import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { HandoffContext, SpecFile } from '../types';

export function IdeHandoff({ repoId, spec, onDone, profileId }: { repoId: string; spec: SpecFile; onDone?: () => void; profileId?: string }) {
  const [handoff, setHandoff] = useState<HandoffContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [showContext, setShowContext] = useState(false);
  const contextRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let alive = true;
    api.handoff(repoId, spec.ticketId).then((value) => { if (alive) { setHandoff(value); setError(null); } }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [repoId, spec.ticketId, spec.updatedAt]);
  useEffect(() => { if (showContext) { contextRef.current?.focus(); contextRef.current?.select(); } }, [showContext]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null); setNotice('');
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section aria-label="Continue in VS Code" className="sticky top-0 z-10 rounded-xl bg-blue-50 border border-blue-100 p-3 flex flex-col gap-2">
    <div className="flex flex-wrap gap-2 items-center">
      <strong className="text-sm mr-auto">Continue in VS Code</strong>
      <button disabled={busy} onClick={() => run(async () => {
        const context = await api.handoff(repoId, spec.ticketId);
        setHandoff(context);
        try { await navigator.clipboard.writeText(context.context); setNotice('Context copied.'); }
        catch { setShowContext(true); setNotice('Clipboard unavailable. Select and copy the context below.'); }
      })} className="bg-white border border-blue-200 rounded-lg px-3 py-1.5 text-xs disabled:opacity-50">Copy context</button>
      {handoff?.mode !== 'ide' && <button disabled={busy || !handoff?.canHandoff} onClick={() => run(async () => {
        const transferred = await api.handoff(repoId, spec.ticketId, true);
        setHandoff(transferred); setShowContext(true); setNotice('Dashboard execution stopped. Open the workspace and paste this context into your IDE agent.'); onDone?.();
      })} className="bg-white border border-blue-200 rounded-lg px-3 py-1.5 text-xs disabled:opacity-50">Continue in IDE</button>}
      {handoff?.mode === 'ide' && spec.execution.status !== 'completed' && <button disabled={busy} onClick={() => run(async () => {
        await api.resumeAutomation(repoId, spec.ticketId, profileId || undefined);
        setHandoff(await api.handoff(repoId, spec.ticketId)); setNotice('Dashboard execution resumed.'); onDone?.();
      })} className="joule-gradient text-white rounded-lg px-3 py-1.5 text-xs disabled:opacity-50">Resume in Dashboard</button>}
    </div>
    <p className="text-xs text-slate-600">Copying context keeps execution unchanged. Continue in IDE stops Dashboard execution before handing over.</p>
    <p className="text-xs text-slate-600">In your IDE agent, run <code className="rounded bg-white px-1 py-0.5 text-blue-700">/specflow {spec.ticketId}</code>.</p>
    {handoff?.reason && !handoff.canHandoff && <p className="text-xs text-slate-600">{handoff.reason}</p>}
    {handoff?.mode === 'ide' && <a className="text-xs text-blue-700 underline w-fit" href={'vscode://file' + handoff.workspacePath.split('/').map(encodeURIComponent).join('/')}>Open workspace in VS Code</a>}
    {notice && <p role="status" className="text-xs text-blue-700">{notice}</p>}
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    {showContext && handoff && <label className="field">IDE context<textarea ref={contextRef} readOnly value={handoff.context} rows={5} onFocus={(e) => e.target.select()} /></label>}
  </section>;
}
