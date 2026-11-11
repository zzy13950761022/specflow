import { useEffect, useState } from 'react';
import { api } from '../api';
import { AGENT_LABELS, type AgentProfile, type AgentSettings } from '../types';
import { Dialog } from './Dialog';

const optionalFields = [
  ['model', 'Model', 'Model name'], ['provider', 'Provider', 'Provider name'],
  ['baseUrl', 'Base URL', 'https://…'], ['credentialEnv', 'Credential environment variable', 'HYPERSPACE_API_KEY'],
  ['command', 'Command', 'Use agent default'], ['configPath', 'Config path', 'Use local default'],
] as const;

export function AgentSettingsDialog({ repoId, repoName, onClose }: { repoId: string | null; repoName?: string; onClose: () => void }) {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [checks, setChecks] = useState<Awaited<ReturnType<typeof api.testAgent>>['checks']>([]);
  useEffect(() => {
    let alive = true;
    api.agentSettings().then((value) => { if (alive) { setSettings(value); setProfileId(value.repoDefaults[repoId ?? ''] ?? value.defaultProfileId ?? value.profiles[0]?.id ?? ''); } }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [repoId]);
  const profile = settings?.profiles.find((item) => item.id === profileId);
  function patchProfile(patch: Partial<AgentProfile>) {
    setMessage(''); setChecks([]);
    setSettings((current) => current && ({ ...current, profiles: current.profiles.map((item) => item.id === profileId ? { ...item, ...patch } : item) }));
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null); setMessage('');
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function addProfile() {
    if (!settings) return;
    const added: AgentProfile = { id: 'profile-' + crypto.randomUUID(), name: 'New profile', agent: 'codex', version: 1 };
    setSettings({ ...settings, profiles: [...settings.profiles, added] }); setProfileId(added.id); setMessage(''); setChecks([]);
  }
  return <Dialog title="Agent settings" onClose={onClose} busy={busy}>
    <form onSubmit={(e) => { e.preventDefault(); if (settings) void run(async () => { const saved = await api.saveAgentSettings(settings); setSettings(saved); setMessage('Settings saved.'); }); }}>
      <div className="dialog-body">
        <fieldset disabled={busy} className="p-6 flex flex-col gap-4">
        <p className="text-sm text-slate-600">Save named agent profiles for Dashboard execution. Profiles can use your local agent configuration and Hyperspace model settings.</p>
        {!settings && !error && <p role="status">Loading settings…</p>}
        {settings && <>
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="field">User default<select aria-label="User default" value={settings.defaultProfileId ?? ''} onChange={(e) => setSettings({ ...settings, defaultProfileId: e.target.value || undefined })}><option value="">No default</option>{settings.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            {repoId && <label className="field">Repository default ({repoName ?? repoId})<select aria-label="Repository default" value={settings.repoDefaults[repoId] ?? ''} onChange={(e) => { const defaults = { ...settings.repoDefaults }; if (e.target.value) defaults[repoId] = e.target.value; else delete defaults[repoId]; setSettings({ ...settings, repoDefaults: defaults }); }}><option value="">Use user default</option>{settings.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          </div>
          <div className="border-t border-blue-100 pt-4 flex items-end gap-3">
            <label className="field flex-1">Edit profile<select aria-label="Edit profile" value={profileId} onChange={(e) => { setProfileId(e.target.value); setMessage(''); setChecks([]); }}><option value="">Select profile</option>{settings.profiles.map((item) => <option key={item.id} value={item.id}>{item.name} · {AGENT_LABELS[item.agent]}</option>)}</select></label>
            <button type="button" onClick={addProfile} className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">Add profile</button>
          </div>
          {profile && <div className="grid sm:grid-cols-2 gap-4">
            <label className="field">Profile name<input required value={profile.name} onChange={(e) => patchProfile({ name: e.target.value })} /></label>
            <label className="field">Agent<select aria-label="Agent" value={profile.agent} onChange={(e) => patchProfile({ agent: e.target.value as AgentProfile['agent'] })}>{Object.entries(AGENT_LABELS).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
            {optionalFields.map(([key, label, placeholder]) => <label key={key} className="field">{label}<input value={profile[key] ?? ''} placeholder={placeholder} pattern={key === 'credentialEnv' ? '[A-Za-z_][A-Za-z0-9_]*' : undefined} title={key === 'credentialEnv' ? 'Environment variable name only, such as HYPERSPACE_API_KEY' : undefined} autoComplete="off" onChange={(e) => patchProfile({ [key]: e.target.value || undefined })} /></label>)}
            <p className="text-xs text-slate-500 sm:col-span-2">Credential environment variable stores a variable name only. Set its value in the environment where Dashboard runs. Leave overrides empty to use local configuration.</p>
            <div className="sm:col-span-2 flex flex-wrap gap-3">
              <button type="button" onClick={() => run(async () => {
                const detected = await api.detectAgent({ agent: profile.agent, command: profile.command, configPath: profile.configPath });
                if (detected.error) throw new Error(detected.error);
                if (!detected.available) throw new Error('Agent command is unavailable.');
                const patch: Partial<AgentProfile> = {};
                for (const key of ['configPath', 'provider', 'model', 'baseUrl', 'credentialEnv'] as const) if (!profile[key] && detected[key]) patch[key] = detected[key];
                patchProfile(patch);
                setMessage('Local configuration detected' + (detected.version ? ' · ' + detected.version : '') + '. Empty fields were filled; save to keep changes.');
              })} className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">Detect local config</button>
              <button type="button" onClick={() => run(async () => { const result = await api.testAgent(profile); setChecks(result.checks); setMessage(result.ok ? 'Connection checks passed.' : 'Connection checks failed. Review the results below.'); })} className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">Test connection</button>
            </div>
          </div>}
        </>}
        {checks.length > 0 && <ul className="text-sm space-y-2">{checks.map((check, index) => <li key={index} className={check.status === 'failed' ? 'text-red-600' : 'text-slate-600'}><strong>{check.name}: {check.status}</strong> — {check.message}</li>)}</ul>}
        {busy && <p role="status" className="text-sm text-slate-600">Working…</p>}
        {message && <p role="status" className="text-sm text-blue-700">{message}</p>}
      </fieldset>
      </div>
      <div className="dialog-footer bg-white border-t border-blue-100 flex flex-wrap justify-end gap-3 px-6 py-4">
        {error && <p role="alert" className="text-sm text-red-600 w-full">{error}</p>}
        <button type="button" onClick={onClose} disabled={busy} className="rounded-lg px-4 py-2 text-sm hover:bg-blue-50">Close</button>
        <button type="submit" disabled={busy || !settings || settings.profiles.some((item) => !item.name.trim())} className="joule-gradient rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Save settings</button>
      </div>
    </form>
  </Dialog>;
}
