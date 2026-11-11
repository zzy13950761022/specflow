import { configurationLabel } from '../lib/agent-profiles';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { type AgentSettings, type CreateSpecOptions, type RepoEntry } from '../types';
import { Dialog } from './Dialog';

export function NewSpec({ repos, activeRepo, onClose, onCreate }: {
  repos: RepoEntry[]; activeRepo: string; onClose: () => void;
  onCreate: (repoId: string, ticketId: string, title: string, options: CreateSpecOptions) => Promise<void>;
}) {
  const [repoId, setRepoId] = useState(activeRepo);
  const [ticketId, setTicketId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [workflowKind, setWorkflowKind] = useState<'standard' | 'bugfix' | 'documentation'>('standard');
  const [risk, setRisk] = useState<'low' | 'normal' | 'high'>('normal');
  const [autoChecks, setAutoChecks] = useState(false);
  const [autoRun, setAutoRun] = useState(false);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.agentSettings().then((value) => { if (alive) setSettings(value); }).catch((e) => { if (alive) setSettingsError(e.message); });
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (settings) setProfileId(settings.defaultProfileId ?? ''); }, [repoId, settings]);
  const selectedProfile = settings?.profiles.find((profile) => profile.id === profileId);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await onCreate(repoId, ticketId.trim(), title.trim(), { description: description.trim() || undefined, workflowKind, risk, autoChecks: risk === 'low' && workflowKind !== 'documentation' && autoChecks, autoRun, agentProfileId: selectedProfile?.id });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog title="Create Spec" onClose={onClose} busy={busy}>
      <form onSubmit={create}>
        <div className="dialog-body">
        <fieldset disabled={busy} className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="field sm:col-span-2">Repository<select aria-label="Repository" value={repoId} onChange={(e) => setRepoId(e.target.value)}>{repos.map((repo) => <option value={repo.id} key={repo.id}>{repo.name} — {repo.path}</option>)}</select></label>
          <label className="field">Ticket ID<input required data-autofocus value={ticketId} onChange={(e) => setTicketId(e.target.value)} placeholder="TICKET-123" /></label>
          <label className="field">Workflow type<select aria-label="Workflow type" value={workflowKind} onChange={(e) => setWorkflowKind(e.target.value as typeof workflowKind)}><option value="standard">Standard feature</option><option value="bugfix">Bug fix</option><option value="documentation">Documentation only</option></select></label>
          <label className="field sm:col-span-2">Title<input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Feature title" /></label>
          <label className="field sm:col-span-2">Description<textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the problem, expected outcome, and acceptance criteria…" /></label>
          <label className="field">Change risk<select aria-label="Change risk" value={risk} onChange={(e) => setRisk(e.target.value as typeof risk)}><option value="low">Low risk</option><option value="normal">Normal risk</option><option value="high">High risk</option></select></label>
          <label className="field">Execution<select aria-label="Execution" value={autoRun ? 'dashboard' : 'manual'} onChange={(e) => setAutoRun(e.target.value === 'dashboard')}><option value="manual">Manual / IDE</option><option value="dashboard">Run in Dashboard</option></select></label>
          <label className="field sm:col-span-2">Execution configuration<select aria-label="Execution configuration" value={profileId} onChange={(e) => setProfileId(e.target.value)}><option value="">Select an execution configuration</option>{settings?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{configurationLabel(profile)}</option>)}</select></label>
          {autoRun && !selectedProfile && <p className="text-sm text-slate-600 sm:col-span-2">Choose a saved configuration. Add configurations in Agent settings using the gear in the header.</p>}
          {risk === 'low' && workflowKind !== 'documentation' && <label className="text-sm flex gap-2 sm:col-span-2"><input type="checkbox" checked={autoChecks} onChange={(e) => setAutoChecks(e.target.checked)} />Approve passing test/build checks automatically</label>}
          {settingsError && <p role="alert" className="text-sm text-red-600 sm:col-span-2">Could not load agent profiles: {settingsError}. Manual creation is available.</p>}
        </fieldset>
      </div>
        <div className="dialog-footer bg-white border-t border-blue-100 flex flex-wrap justify-end gap-3 px-6 py-4">
          {error && <p role="alert" className="text-sm text-red-600 w-full">{error}</p>}
          <button type="button" disabled={busy} onClick={onClose} className="rounded-lg px-4 py-2 text-sm hover:bg-blue-50">Cancel</button>
          <button type="submit" disabled={busy || !ticketId.trim() || !title.trim() || (autoRun && !selectedProfile)} className="joule-gradient rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Creating…' : autoRun ? 'Create & Start' : 'Create Spec'}</button>
        </div>
      </form>
    </Dialog>
  );
}
