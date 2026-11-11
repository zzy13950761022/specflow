import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentSettingsStore } from './agent-settings.js';

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(join(tmpdir(), 'agent-settings-')); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
const profile = { id: 'personal', name: 'My Codex', agent: 'codex' as const, version: 1, provider: 'hyperspace', model: 'my-model', credentialEnv: 'HYPERSPACE_API_KEY' };
it('persists local profiles and resolves the user default without changing an earlier snapshot', async () => {
  const store = new AgentSettingsStore(home);
  expect((await store.load()).profiles).toEqual([]);
  const settings = await store.save({ revision: 0, profiles: [profile], defaultProfileId: profile.id });
  const snapshot = await store.resolve();
  await store.save({ ...settings, profiles: [{ ...profile, model: 'new-model' }] });
  expect(snapshot.model).toBe('my-model');
  expect((await store.resolve()).version).toBe(2);
  expect((await new AgentSettingsStore(home).load()).revision).toBe(2);
  expect((await fs.stat(join(home, 'agents.json'))).mode & 0o777).toBe(0o600);
});
it('rejects stale saves, invalid references and credential values', async () => {
  const store = new AgentSettingsStore(home);
  const first = { revision: 0, profiles: [profile] };
  await store.save(first);
  await expect(store.save(first)).rejects.toThrow(/changed|revision/i);
  await expect(store.save({ ...first, revision: 1, defaultProfileId: 'missing' })).rejects.toThrow(/profile/i);
  await expect(store.save({ ...first, revision: 1, profiles: [{ ...profile, credentialEnv: 'Bearer secret' }] })).rejects.toThrow();
  await expect(store.save({ ...first, revision: 1, profiles: [{ ...profile, baseUrl: 'https://user:secret@example.com' }] })).rejects.toThrow();
  await expect(store.save({ ...first, revision: 1, profiles: [profile, profile] })).rejects.toThrow(/unique/i);
});
it('serializes concurrent updates so one stale writer cannot overwrite the other', async () => {
  const store = new AgentSettingsStore(home);
  const results = await Promise.allSettled([store.save({ revision: 0, profiles: [profile] }), store.save({ revision: 0, profiles: [] })]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
});

it('ignores legacy repository defaults and persists only the user default', async () => {
  const store = new AgentSettingsStore(home);
  const alternative = { ...profile, id: 'alternative', name: 'Alternative' };
  await fs.writeFile(join(home, 'agents.json'), JSON.stringify({ revision: 7, profiles: [profile, alternative], defaultProfileId: profile.id, repoDefaults: { repo: alternative.id, deleted: 'missing-profile' } }));
  const loaded = await store.load();
  expect(loaded).not.toHaveProperty('repoDefaults');
  expect((await store.resolve()).id).toBe(profile.id);
  expect((await store.resolve(alternative.id)).id).toBe(alternative.id);
  await store.save(loaded);
  expect(JSON.parse(await fs.readFile(join(home, 'agents.json'), 'utf8'))).not.toHaveProperty('repoDefaults');
});

it('does not promote an old repository default when no user default is set', async () => {
  const store = new AgentSettingsStore(home);
  await fs.writeFile(join(home, 'agents.json'), JSON.stringify({ revision: 0, profiles: [profile], repoDefaults: { repo: profile.id } }));
  await expect(store.resolve()).rejects.toThrow(/choose/i);
  expect((await store.resolve(profile.id)).id).toBe(profile.id);
});
