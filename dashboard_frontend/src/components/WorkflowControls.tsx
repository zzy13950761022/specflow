import { configurationLabel } from '../lib/agent-profiles';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { AGENT_LABELS, type AgentSettings, type SpecFile, type Stage } from '../types';

export function WorkflowControls({ repoId, spec, stage, onDone, profileId, onProfileChange }: { repoId: string; spec: SpecFile; stage: Stage; onDone: () => void; profileId: string; onProfileChange: (id: string) => void }) {
  const [reason, setReason] = useState('');
  const [reworking, setReworking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [runnerAvailable, setRunnerAvailable] = useState(false);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  useEffect(() => { let alive = true; api.agentSettings().then((value) => { if (alive) { setSettings(value); onProfileChange(spec.automation?.profile ? '' : value.repoDefaults[repoId] ?? value.defaultProfileId ?? ''); } }).catch((e) => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [repoId, spec.ticketId, spec.automation?.profile?.id, spec.automation?.profile?.version, onProfileChange]);
  useEffect(() => { let alive = true; api.automationAvailable().then((value) => { if (alive) setRunnerAvailable(value.available); }).catch(() => {}); return () => { alive = false; }; }, []);
  useEffect(() => {
    let alive = true;
    api.execution(repoId, spec.ticketId).then((execution) => { if (alive) setNext(execution.error ?? execution.actions[0]?.reason ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [repoId, spec.ticketId, spec.updatedAt, stage.revision]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); setReworking(false); setReason(''); onDone(); }
    catch (error) { setError(String((error as Error).message)); }
    finally { setBusy(false); }
  }
  const paused = spec.execution.status === 'paused';
  const active = spec.currentStageId === stage.id;
  const canAdvance = active && !spec.automation?.enabled && stage.gate.status === 'approved' && stage.id !== 'ops' && (stage.id !== 'develop' || (stage.subtasks?.length && stage.subtasks.every((task) => task.completed && task.review?.status === 'approved')));
  return (
    <div className="glass rounded-2xl px-4 py-3 flex flex-col gap-2">
      <div className="flex flex-wrap gap-3 items-center text-sm">
        <span>{spec.workflow.workflowKind} · {spec.workflow.risk} risk</span>
        <span>Execution: {spec.execution.status.replaceAll('_', ' ')}</span>
        {spec.automation && <span>{spec.automation.profile ? AGENT_LABELS[spec.automation.profile.agent] : 'Agent'}: {spec.automation.status.replaceAll('_', ' ')}{spec.automation.profile ? ' · ' + spec.automation.profile.name : ''}{spec.automation.mode === 'ide' ? ' · IDE' : ''}</span>}
        {(runnerAvailable || !!settings?.profiles.length) && !spec.automation?.enabled && spec.execution.status !== 'completed' && spec.automation?.mode !== 'ide' && <button disabled={busy} className="rounded-lg px-3 py-1 bg-blue-100 disabled:opacity-50" onClick={() => run(() => api.configureAutomation(repoId, spec.ticketId, true, profileId || undefined))}>Run in Dashboard</button>}
        {spec.automation?.status === 'failed' && <button disabled={busy} className="rounded-lg px-3 py-1 bg-orange-100 disabled:opacity-50" onClick={() => run(() => api.retryAutomation(repoId, spec.ticketId))}>Retry agent execution</button>}
        {!spec.automation?.enabled && !!settings?.profiles.length && <label className="text-xs flex items-center gap-2">Execution configuration<select aria-label="Execution configuration" className="toolbar-control" value={profileId} onChange={(e) => onProfileChange(e.target.value)}><option value="">{spec.automation?.profile ? 'Keep current configuration · ' + spec.automation.profile.name + ' v' + spec.automation.profile.version : 'Use default configuration'}</option>{settings.profiles.map((profile) => <option key={profile.id} value={profile.id}>{configurationLabel(profile)}</option>)}</select></label>}
        <span className="text-xs text-slate-500">Retries: {spec.execution.retryCount}</span>
        {spec.execution.status !== 'completed' && (
          <button disabled={busy} className="rounded-lg px-3 py-1 bg-blue-100 disabled:opacity-50" onClick={() => run(() => paused ? api.resume(repoId, spec.ticketId) : api.pause(repoId, spec.ticketId))}>
            {paused ? 'Resume execution' : 'Pause execution'}
          </button>
        )}
        {stage.artifact && !stage.skipped && !paused && spec.automation?.status !== 'running' && (
          <button disabled={busy} className="rounded-lg px-3 py-1 bg-orange-100 disabled:opacity-50" onClick={() => setReworking(!reworking)}>Reopen stage</button>
        )}
        {canAdvance && !paused && <button disabled={busy} className="rounded-lg px-3 py-1 bg-blue-100 disabled:opacity-50" onClick={() => run(() => api.advance(repoId, spec.ticketId, stage.id))}>Advance stage</button>}
        {active && !paused && !spec.automation?.enabled && (stage.id === 'test' || stage.id === 'build') && stage.gate.status !== 'approved' && (
          <button disabled={busy || !!stage.activeCheck} className="rounded-lg px-3 py-1 bg-blue-100 disabled:opacity-50" onClick={() => run(() => api.runCheck(repoId, spec.ticketId, stage.id as 'test' | 'build'))}>
            {stage.activeCheck ? 'Check running…' : 'Run ' + stage.id + ' check'}
          </button>
        )}
      </div>
      {spec.execution.lastSuccessfulStep && <p className="text-xs text-slate-500">Last successful step: {spec.execution.lastSuccessfulStep}</p>}
      {spec.automation?.error && <p role="alert" className="text-sm text-red-600">{spec.automation.error}</p>}
      {spec.automation?.worktreePath && <p className="text-xs text-slate-500 break-all">Workspace: {spec.automation.worktreePath}</p>}
      {spec.automation?.threadId && <p className="text-xs text-slate-500 break-all">Agent session: {spec.automation.threadId}</p>}
      {next && <p className="text-xs text-slate-500">{next}</p>}
      {reworking && (
        <div className="flex gap-2">
          <input aria-label="Rework reason" placeholder="Why does this stage need rework?" value={reason} onChange={(event) => setReason(event.target.value)} className="flex-1 border border-blue-200 rounded-lg p-2 text-sm" />
          <button disabled={busy || !reason.trim()} onClick={() => run(() => api.reopen(repoId, spec.ticketId, stage.id, reason.trim()))} className="rounded-lg bg-orange-100 px-3 text-sm disabled:opacity-50">Confirm rework</button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
