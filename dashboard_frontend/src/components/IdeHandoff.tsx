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
  return <section aria-label="Continue in VS Code" className="rounded-lg bg-blue-50 border border-blue-100 px-2 py-1.5 flex flex-col gap-2">
    <div className="flex flex-wrap gap-2 items-center">
      <span className="text-xs text-slate-600">Continue in VS Code</span>
      <code className="text-xs text-blue-700 mr-auto">/specflow {spec.ticketId}</code>
      <button title="Copy the latest context without changing execution" disabled={busy} onClick={() => run(async () => {
        const context = await api.handoff(repoId, spec.ticketId);
        setHandoff(context);
        try { await navigator.clipboard.writeText(context.context); setNotice('Context copied.'); }
        catch { setShowContext(true); setNotice('Clipboard unavailable. Select and copy the context below.'); }
      })} className="bg-white border border-blue-200 rounded-lg px-3 py-1.5 text-xs disabled:opacity-50">Copy context</button>
      {handoff?.mode !== 'ide' && <button title="Stop Dashboard execution and hand work to your IDE" disabled={busy || !handoff?.canHandoff} onClick={() => run(async () => {
        const transferred = await api.handoff(repoId, spec.ticketId, true);
        setHandoff(transferred); setShowContext(true); setNotice('Dashboard execution stopped. Open the workspace and paste this context into your IDE agent.'); onDone?.();
      })} className="bg-white border border-blue-200 rounded-lg px-3 py-1.5 text-xs disabled:opacity-50">Continue in IDE</button>}
      {handoff?.mode === 'ide' && spec.execution.status !== 'completed' && <button disabled={busy} onClick={() => run(async () => {
        await api.resumeAutomation(repoId, spec.ticketId, profileId || undefined);
        setHandoff(await api.handoff(repoId, spec.ticketId)); setShowContext(false); setNotice('Dashboard execution resumed.'); onDone?.();
      })} className="joule-gradient text-white rounded-lg px-3 py-1.5 text-xs disabled:opacity-50">Resume in Dashboard</button>}
    </div>
    {handoff?.reason && !handoff.canHandoff && <p className="text-xs text-slate-600">{handoff.reason}</p>}
    {handoff?.mode === 'ide' && <a className="text-xs text-blue-700 underline w-fit" href={'vscode://file' + handoff.workspacePath.split('/').map(encodeURIComponent).join('/')}>Open workspace in VS Code</a>}
    {notice && <p role="status" className="text-xs text-blue-700">{notice}</p>}
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    {showContext && handoff && <div className="space-y-2"><button className="text-xs text-blue-700" onClick={() => setShowContext(false)}>Hide context</button><label className="field">IDE context<textarea ref={contextRef} readOnly value={handoff.context} rows={5} onFocus={(e) => e.target.select()} /></label></div>}
  </section>;
}
