import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentSettingsStore } from './agent-settings.js';

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(join(tmpdir(), 'agent-settings-')); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
const profile = { id: 'personal', name: 'My Codex', agent: 'codex' as const, version: 1, provider: 'hyperspace', model: 'my-model', credentialEnv: 'HYPERSPACE_API_KEY' };
it('persists local profiles and resolves repository defaults without changing an earlier snapshot', async () => {
  const store = new AgentSettingsStore(home);
  expect((await store.load()).profiles).toEqual([]);
  const settings = await store.save({ revision: 0, profiles: [profile], defaultProfileId: profile.id, repoDefaults: {} });
  const snapshot = await store.resolve('repo');
  await store.save({ ...settings, profiles: [{ ...profile, model: 'new-model' }] });
  expect(snapshot.model).toBe('my-model');
  expect((await store.resolve('repo')).version).toBe(2);
  expect((await new AgentSettingsStore(home).load()).revision).toBe(2);
  expect((await fs.stat(join(home, 'agents.json'))).mode & 0o777).toBe(0o600);
});
it('rejects stale saves, invalid references and credential values', async () => {
  const store = new AgentSettingsStore(home);
  const first = { revision: 0, profiles: [profile], repoDefaults: {} };
  await store.save(first);
  await expect(store.save(first)).rejects.toThrow(/changed|revision/i);
  await expect(store.save({ ...first, revision: 1, defaultProfileId: 'missing' })).rejects.toThrow(/profile/i);
  await expect(store.save({ ...first, revision: 1, profiles: [{ ...profile, credentialEnv: 'Bearer secret' }] })).rejects.toThrow();
  await expect(store.save({ ...first, revision: 1, profiles: [{ ...profile, baseUrl: 'https://user:secret@example.com' }] })).rejects.toThrow();
  await expect(store.save({ ...first, revision: 1, profiles: [profile, profile] })).rejects.toThrow(/unique/i);
});
it('serializes concurrent updates so one stale writer cannot overwrite the other', async () => {
  const store = new AgentSettingsStore(home);
  const results = await Promise.allSettled([store.save({ revision: 0, profiles: [profile], repoDefaults: {} }), store.save({ revision: 0, profiles: [], repoDefaults: {} })]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
});
