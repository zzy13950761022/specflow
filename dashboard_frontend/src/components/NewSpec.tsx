import { configurationLabel } from '../lib/agent-profiles';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { type AgentSettings, type CreateSpecOptions } from '../types';
import { Dialog } from './Dialog';

export function NewSpec({ activeRepo, onClose, onCreate }: {
  activeRepo: string; onClose: () => void;
  onCreate: (repoId: string, ticketId: string, title: string, options: CreateSpecOptions) => Promise<void>;
}) {
  const [ticketId, setTicketId] = useState('');
  const [description, setDescription] = useState('');
  const [jiraConfigured, setJiraConfigured] = useState(false);
  const [jiraAuthAvailable, setJiraAuthAvailable] = useState(false);
  const [jiraAuthenticating, setJiraAuthenticating] = useState(false);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [jiraError, setJiraError] = useState('');
  const [importedKey, setImportedKey] = useState('');
  const requestVersion = useRef(0);
  const descriptionRef = useRef('');
  const importedText = useRef('');
  const jiraKey = ticketId.trim().toUpperCase();
  const validJiraKey = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(jiraKey);
  const [workflowKind, setWorkflowKind] = useState<'standard' | 'bugfix' | 'documentation'>('standard');
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.jiraStatus().then(value => { if (alive) { setJiraConfigured(value.configured); setJiraAuthAvailable(!!value.authenticationAvailable); } }).catch(error => { if (alive) setJiraError(error.message); });
    api.agentSettings().then((value) => { if (alive) setSettings(value); }).catch((e) => { if (alive) setSettingsError(e.message); });
    return () => { alive = false; requestVersion.current++; };
  }, []);
  useEffect(() => { if (settings) setProfileId(settings.defaultProfileId ?? ''); }, [settings]);
  async function importJira(key: string, authenticateIfNeeded = false) {
    const version = ++requestVersion.current;
    let authenticating = false;
    setJiraLoading(true); setJiraError('');
    try {
      let issue;
      try { issue = await api.jiraIssue(key); }
      catch (error) {
        if (version !== requestVersion.current) return;
        if (!authenticateIfNeeded || !jiraAuthAvailable || !(error instanceof ApiError) || error.code !== 'SAP_AUTH_REQUIRED') throw error;
        authenticating = true; setJiraAuthenticating(true);
        await api.jiraAuthenticate();
        if (version !== requestVersion.current) return;
        authenticating = false; setJiraAuthenticating(false);
        // Retry the original ticket once. Continued auth failures remain visible.
        issue = await api.jiraIssue(key);
      }
      if (version !== requestVersion.current) return;
      const text = issue.summary + (issue.description ? String.fromCharCode(10, 10) + issue.description : '');
      importedText.current = text; descriptionRef.current = text;
      setDescription(text); setImportedKey(issue.key);
    } catch (error) {
      if (version === requestVersion.current) setJiraError(error instanceof ApiError && error.code === 'SAP_AUTH_REQUIRED'
        ? 'Jira sign-in is required. Click Load / Replace from Jira to authenticate and retry.'
        : (error as Error).message);
    } finally {
      if (authenticating) setJiraAuthenticating(false);
      if (version === requestVersion.current) setJiraLoading(false);
    }
  }
  useEffect(() => {
    if (!jiraConfigured || jiraAuthenticating || !validJiraKey || descriptionRef.current.trim()) return;
    const version = requestVersion.current;
    const timer = setTimeout(() => { if (version === requestVersion.current && !descriptionRef.current.trim()) void importJira(jiraKey); }, 600);
    return () => clearTimeout(timer);
  }, [jiraKey, jiraConfigured]);
  function changeTicket(value: string) {
    requestVersion.current++; setJiraLoading(false); setJiraError(''); setImportedKey('');
    if (descriptionRef.current === importedText.current) { setDescription(''); descriptionRef.current = ''; }
    importedText.current = ''; setTicketId(value);
  }
  function changeDescription(value: string) {
    requestVersion.current++; setJiraLoading(false); setImportedKey('');
    descriptionRef.current = value; setDescription(value);
  }
  const selectedProfile = settings?.profiles.find((profile) => profile.id === profileId);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy || jiraLoading || jiraAuthenticating || !ticketId.trim() || !description.trim() || !selectedProfile) return;
    const summary = description.trim().split(/\r?\n/)[0].replace(/^#{1,6}\s+/, '').trim();
    const title = Array.from(summary).slice(0, 120).join('') || ticketId.trim();
    setBusy(true); setError(null);
    try {
      await onCreate(activeRepo, ticketId.trim(), title.trim(), { description: description.trim() || undefined, workflowKind, risk: 'normal', autoChecks: false, autoRun: true, agentProfileId: selectedProfile.id });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog title="Create Spec" onClose={onClose} busy={busy}>
      <form onSubmit={create}>
        <div className="dialog-body">
        <fieldset disabled={busy} className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="field">Ticket ID<input required data-autofocus value={ticketId} onChange={(e) => changeTicket(e.target.value)} placeholder="TICKET-123" /></label>
          <label className="field">Workflow type<select aria-label="Workflow type" value={workflowKind} onChange={(e) => setWorkflowKind(e.target.value as typeof workflowKind)}><option value="standard">Standard feature</option><option value="bugfix">Bug fix</option><option value="documentation">Documentation only</option></select></label>
          {jiraConfigured && <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy || jiraLoading || jiraAuthenticating || !validJiraKey} onClick={() => void importJira(jiraKey, true)} className="rounded-lg border border-blue-200 px-3 py-1.5 text-xs disabled:opacity-50">{jiraAuthenticating ? 'Signing in…' : description.trim() ? 'Replace from Jira' : 'Load from Jira'}</button>
            {jiraAuthenticating && <span role="status" className="text-xs text-slate-500">Complete SAP SSO in the browser on the Dashboard host. This may take a few minutes.</span>}
            {jiraAuthenticating ? null : jiraLoading ? <span role="status" className="text-xs text-slate-500">Loading Jira ticket…</span> : importedKey ? <span role="status" className="text-xs text-emerald-700">Imported {importedKey} from Jira. You can edit the requirements below.</span> : <span className="text-xs text-slate-500">An empty description is filled automatically from the Ticket ID.</span>}
          </div>}
          {jiraError && <p role="alert" className="text-sm text-orange-700 sm:col-span-2">{jiraError} You can also enter the description manually.</p>}
          <label className="field sm:col-span-2">Description<textarea aria-label="Description" required maxLength={30000} rows={5} value={description} onChange={(e) => changeDescription(e.target.value)} placeholder="Start with a short summary, then describe the requirements and acceptance criteria…" /></label>
          <p className="text-xs text-slate-500 sm:col-span-2">The first line becomes the title. Work starts in Dashboard; use Continue in IDE whenever you need to switch.</p>
          <label className="field sm:col-span-2">Execution configuration<select aria-label="Execution configuration" value={profileId} onChange={(e) => setProfileId(e.target.value)}><option value="">Select an execution configuration</option>{settings?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{configurationLabel(profile)}</option>)}</select></label>
          {!selectedProfile && <p className="text-sm text-slate-600 sm:col-span-2">Choose a saved configuration. Add configurations in Agent settings using the gear in the header.</p>}
          {settingsError && <p role="alert" className="text-sm text-red-600 sm:col-span-2">Could not load execution configurations: {settingsError}. Reopen this dialog to retry.</p>}
        </fieldset>
      </div>
        <div className="dialog-footer bg-white border-t border-blue-100 flex flex-wrap justify-end gap-3 px-6 py-4">
          {error && <p role="alert" className="text-sm text-red-600 w-full">{error}</p>}
          <button type="button" disabled={busy} onClick={onClose} className="rounded-lg px-4 py-2 text-sm hover:bg-blue-50">Cancel</button>
          <button type="submit" disabled={busy || jiraLoading || jiraAuthenticating || !ticketId.trim() || !description.trim() || !selectedProfile} className="joule-gradient rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Creating…' : 'Create & Start'}</button>
        </div>
      </form>
    </Dialog>
  );
}
