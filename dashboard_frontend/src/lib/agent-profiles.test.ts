import { expect, it } from 'vitest';
import type { AgentProfile } from '../types';
import { configurationLabel, changeAgent, useLocalModel, useConfiguredModel, useCustomModel } from './agent-profiles';

const profile: AgentProfile = { id: 'p', version: 2, name: 'Codex', agent: 'codex', model: 'old-model', provider: 'old-provider', baseUrl: 'https://old.example', credentialEnv: 'OLD_KEY', command: '/old/codex', configPath: '/old/config.toml' };

it('labels automatic configurations without repeating the Agent, preserving custom names', () => {
  expect(configurationLabel(profile)).toBe('Codex · old-model');
  expect(configurationLabel({ ...profile, name: 'Daily work' })).toBe('Daily work · Codex · old-model');
  expect(configurationLabel({ ...profile, name: 'New profile', model: undefined })).toBe('Codex · Local current model');
});

it('switching Agent clears incompatible program and transport while retaining identity and custom name', () => {
  expect(changeAgent(profile, 'claude')).toEqual({ id: 'p', version: 2, name: 'Claude Code', agent: 'claude' });
  expect(changeAgent({ ...profile, name: 'Daily work' }, 'opencode').name).toBe('Daily work');
});

it('local or declared models clear overrides from the previous provider while preserving selected installation', () => {
  expect(useLocalModel(profile)).toEqual({ id: 'p', version: 2, name: 'Codex', agent: 'codex', command: '/old/codex', configPath: '/old/config.toml' });
  expect(useConfiguredModel(profile, { id: 'new-model', provider: 'new-provider', label: 'New' })).toEqual({ ...useLocalModel(profile), model: 'new-model', provider: 'new-provider' });
});

it('custom OpenCode model entry moves provider and clears old endpoint credentials together', () => {
  const old = { ...profile, agent: 'opencode' as const, model: 'old-provider/old-model' };
  expect(useCustomModel(old, 'new-provider/custom')).toEqual({ ...useLocalModel(old), model: 'new-provider/custom', provider: 'new-provider' });
  expect(useCustomModel(old, 'old-provider/custom')).toEqual({ ...old, model: 'old-provider/custom' });
});
