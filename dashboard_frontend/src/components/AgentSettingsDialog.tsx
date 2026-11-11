import { useEffect, useState } from 'react';
import { api } from '../api';
import { AGENT_LABELS, type AgentDetection, type AgentProfile, type AgentSettings } from '../types';
import { changeAgent, configurationLabel, useConfiguredModel, useCustomModel, useLocalModel } from '../lib/agent-profiles';
import { Dialog } from './Dialog';

const advancedFields = [
  ['provider', 'Provider', 'Use local provider'],
  ['baseUrl', 'Base URL', 'Use local endpoint'],
  ['credentialEnv', 'Credential environment variable', 'HYPERSPACE_API_KEY'],
  ['command', 'Command', 'Automatically find an installation'],
  ['configPath', 'Config path', 'Use local default'],
] as const;
const modelExamples = { codex: 'e.g. gpt-6.1-sol', claude: 'e.g. sonnet', opencode: 'e.g. provider/model-id' };

export function AgentSettingsDialog({ repoId, repoName, onClose }: { repoId: string | null; repoName?: string; onClose: () => void }) {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [checks, setChecks] = useState<Awaited<ReturnType<typeof api.testAgent>>['checks']>([]);
  const [refresh, setRefresh] = useState(0);
  const [discovery, setDiscovery] = useState<{ key: string; result?: AgentDetection; error?: string } | null>(null);
  const [query, setQuery] = useState('');
  const [customModel, setCustomModel] = useState(false);

  useEffect(() => {
    let alive = true;
    api.agentSettings().then((value) => {
      if (alive) { setSettings(value); setProfileId(value.repoDefaults[repoId ?? ''] ?? value.defaultProfileId ?? value.profiles[0]?.id ?? ''); }
    }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [repoId]);

  const profile = settings?.profiles.find((item) => item.id === profileId);
  const lookupKey = JSON.stringify([profileId, profile?.agent, profile?.command || undefined, profile?.configPath || undefined, refresh]);
  const currentDiscovery = discovery?.key === lookupKey ? discovery : null;
  const detected = currentDiscovery?.result;
  const detecting = !!profile && !currentDiscovery;

  useEffect(() => {
    if (!profile) return;
    let alive = true;
    const timer = setTimeout(() => {
      api.detectAgent({ agent: profile.agent, command: profile.command || undefined, configPath: profile.configPath || undefined })
        .then((result) => {
          if (!alive) return;
          setDiscovery({ key: lookupKey, ...(result.error || !result.available
            ? { error: result.error || 'No working installation found. Set Command in Advanced settings.' }
            : { result }) });
        }).catch((e) => { if (alive) setDiscovery({ key: lookupKey, error: e.message }); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [lookupKey]);

  function replaceProfile(value: AgentProfile) {
    setMessage(''); setChecks([]); setError(null);
    setSettings((current) => current && ({ ...current, profiles: current.profiles.map((item) => item.id === value.id ? value : item) }));
  }
  function patchProfile(patch: Partial<AgentProfile>) { if (profile) replaceProfile({ ...profile, ...patch }); }
  function selectProfile(id: string) { setProfileId(id); setMessage(''); setChecks([]); setError(null); setQuery(''); setCustomModel(false); }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null); setMessage('');
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function addProfile() {
    if (!settings) return;
    const added: AgentProfile = { id: 'profile-' + crypto.randomUUID(), name: 'Codex', agent: 'codex', version: 1 };
    setSettings({ ...settings, profiles: [...settings.profiles, added] }); selectProfile(added.id);
  }
  function resolvedProfile(value: AgentProfile): AgentProfile {
    return { ...value, name: value.name.trim() || AGENT_LABELS[value.agent],
      ...(!value.command && value.id === profileId && detected?.command ? { command: detected.command } : {}) };
  }
  const models = detected?.models ?? [];
  const selectedModel = profile?.model ? models.findIndex((model) => model.id === profile.model && (!profile.provider || model.provider === profile.provider)) : -1;
  const modelValue = customModel || (profile?.model && selectedModel < 0) ? 'custom' : selectedModel >= 0 ? 'configured:' + selectedModel : '';
  const visibleModels = models.map((model, index) => ({ ...model, index })).filter((model) => model.index === selectedModel ||
    (model.label + ' ' + model.id + ' ' + (model.provider ?? '')).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  return <Dialog title="Agent settings" onClose={onClose} busy={busy}>
    <form onSubmit={(e) => {
      e.preventDefault();
      if (settings && !detecting) void run(async () => {
        const saved = await api.saveAgentSettings({ ...settings, profiles: settings.profiles.map(resolvedProfile) });
        setSettings(saved); setMessage('Settings saved.');
      });
    }}>
      <div className="dialog-body">
        <fieldset disabled={busy} className="p-6 flex flex-col gap-4">
          <p className="text-sm text-slate-600">Choose an Agent to use your local connection and model. Give configurations a custom name only when you need to distinguish them.</p>
          {!settings && !error && <p role="status">Loading settings…</p>}
          {settings && <>
            <div className="flex items-end gap-3">
              <label className="field flex-1">Execution configuration<select aria-label="Edit configuration" value={profileId} onChange={(e) => selectProfile(e.target.value)}><option value="">Select a configuration</option>{settings.profiles.map((item) => <option key={item.id} value={item.id}>{configurationLabel(item)}</option>)}</select></label>
              <button type="button" onClick={addProfile} className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">Add configuration</button>
            </div>
            {profile && <>
              <label className="field">Agent<select aria-label="Agent" value={profile.agent} onChange={(e) => {
                replaceProfile(changeAgent(profile, e.target.value as AgentProfile['agent'])); setCustomModel(false); setQuery('');
              }}>{Object.entries(AGENT_LABELS).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
              <div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm space-y-2">
                {detecting && <p role="status">Reading local configuration…</p>}
                {currentDiscovery?.error && <p role="alert" className="text-red-600">{currentDiscovery.error}</p>}
                {detected && <>
                  <p role="status">Local configuration detected{detected.version ? ' · ' + detected.version : ''}</p>
                  <p className="text-xs text-slate-600">Using {detected.installations?.find((item) => item.command === detected.command)?.label || AGENT_LABELS[profile.agent]}</p>
                  <p>Current: {detected.model || 'Agent default'}</p>
                  {detected.baseUrl && <p className="text-xs text-slate-600 break-all">Connection: {detected.baseUrl}</p>}
                </>}
                <button type="button" disabled={detecting} onClick={() => { setRefresh((value) => value + 1); setChecks([]); setMessage(''); }} className="text-blue-700 disabled:opacity-50">Refresh local config</button>
              </div>
              {models.length > 1 && <label className="field">Search models<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search configured models" /></label>}
              <label className="field">Model<select aria-label="Model" value={modelValue} disabled={detecting} onChange={(e) => {
                setCustomModel(e.target.value === 'custom');
                if (!e.target.value) replaceProfile(useLocalModel(profile));
                else if (e.target.value !== 'custom') replaceProfile(useConfiguredModel(profile, models[Number(e.target.value.split(':')[1])]));
              }}>
                <option value="">Use local current model</option>
                {visibleModels.map((model) => <option key={model.index} value={'configured:' + model.index}>{model.label}{model.provider ? ' · ' + model.provider : ''}</option>)}
                <option value="custom">Custom model…</option>
              </select></label>
              {modelValue === 'custom' && <label className="field">Custom model ID<input aria-label="Custom model ID" value={profile.model ?? ''} placeholder={modelExamples[profile.agent]} onChange={(e) => replaceProfile(useCustomModel(profile, e.target.value))} /><span className="text-xs text-slate-500">{profile.agent === 'opencode' ? 'Use the provider/model-id from your OpenCode configuration.' : 'Use a model ID or alias supported by your configured connection.'}</span></label>}
              <p className="text-xs text-slate-500">{detecting ? 'Reading available model choices…' : models.length ? 'Choices come from local configuration; Test connection confirms access.' : 'No model list is available. Use the local current model or enter a custom model.'}</p>
              <details className="rounded-xl border border-blue-100 p-3">
                <summary className="cursor-pointer text-sm font-medium text-blue-700">Advanced settings</summary>
                <div className="mt-4 grid sm:grid-cols-2 gap-4">
              {!!detected?.installations?.length && <label className="field sm:col-span-2">Installation<select aria-label="Installation" value={profile.command || detected.command || ''} onChange={(e) => patchProfile({ command: e.target.value || undefined })}>
                {profile.command && !detected.installations.some((item) => item.command === profile.command) && <option value={profile.command}>{profile.command}</option>}
                {detected.installations.map((item) => <option key={item.command} value={item.command}>{item.label} · {item.command}</option>)}
              </select></label>}

                  <label className="field sm:col-span-2">Configuration name<input aria-label="Configuration name" value={profile.name} placeholder={AGENT_LABELS[profile.agent]} onChange={(e) => patchProfile({ name: e.target.value })} /><span className="text-xs text-slate-500">Optional. Defaults to the Agent name.</span></label>
                  {advancedFields.map(([key, label, placeholder]) => <label key={key} className="field">{label}<input value={profile[key] ?? ''} placeholder={key === 'command' && detected?.command ? detected.command : placeholder} pattern={key === 'credentialEnv' ? '[A-Za-z_][A-Za-z0-9_]*' : undefined} title={key === 'credentialEnv' ? 'Environment variable name only, such as HYPERSPACE_API_KEY' : undefined} autoComplete="off" onChange={(e) => patchProfile({ [key]: e.target.value || undefined })} /></label>)}
                  <p className="text-xs text-slate-500 sm:col-span-2">Leave overrides empty to use local settings. Credential environment variable stores a variable name only; set its value where Dashboard runs.</p>
                </div>
              </details>
              <div><button type="button" disabled={detecting} onClick={() => run(async () => {
                const result = await api.testAgent(resolvedProfile(profile)); setChecks(result.checks);
                setMessage(result.ok ? 'Connection checks passed.' : 'Connection checks failed. Review the results below.');
              })} className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700 disabled:opacity-50">Test connection</button></div>
            </>}
            <div className="grid sm:grid-cols-2 gap-4 border-t border-blue-100 pt-4">
              <label className="field">User default<select aria-label="User default" value={settings.defaultProfileId ?? ''} onChange={(e) => setSettings({ ...settings, defaultProfileId: e.target.value || undefined })}><option value="">No default</option>{settings.profiles.map((item) => <option key={item.id} value={item.id}>{configurationLabel(item)}</option>)}</select></label>
              {repoId && <label className="field">Repository default ({repoName ?? repoId})<select aria-label="Repository default" value={settings.repoDefaults[repoId] ?? ''} onChange={(e) => { const defaults = { ...settings.repoDefaults }; if (e.target.value) defaults[repoId] = e.target.value; else delete defaults[repoId]; setSettings({ ...settings, repoDefaults: defaults }); }}><option value="">Use user default</option>{settings.profiles.map((item) => <option key={item.id} value={item.id}>{configurationLabel(item)}</option>)}</select></label>}
            </div>
          </>}
          {checks.length > 0 && <ul className="text-sm space-y-2">{checks.map((check, index) => <li key={index} className={check.status === 'failed' ? 'text-red-600' : 'text-slate-600'}><strong>{check.name}: {check.status}</strong> — {check.message}</li>)}</ul>}
          {busy && <p role="status" className="text-sm text-slate-600">Working…</p>}
          {message && <p role="status" className="text-sm text-blue-700">{message}</p>}
        </fieldset>
      </div>
      <div className="dialog-footer bg-white border-t border-blue-100 flex flex-wrap justify-end gap-3 px-6 py-4">
        {error && <p role="alert" className="text-sm text-red-600 w-full">{error}</p>}
        <button type="button" onClick={onClose} disabled={busy} className="rounded-lg px-4 py-2 text-sm hover:bg-blue-50">Close</button>
        <button type="submit" disabled={busy || !settings || detecting} className="joule-gradient rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Save settings</button>
      </div>
    </form>
  </Dialog>;
}
