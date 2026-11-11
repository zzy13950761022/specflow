import { expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectAgent, nativeConfiguration, pinProfile } from './agent-detection.js';

it('rejects conflicting OpenCode provider and qualified model selections', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'native-config-'));
  try {
    const configPath = join(root, 'native.json'); await fs.writeFile(configPath, '{}');
    await expect(nativeConfiguration({ id: 'p', name: 'P', agent: 'opencode', version: 1, configPath, provider: 'new-provider', model: 'old-provider/model-a', baseUrl: 'https://new.example/v1' }).then(() => undefined)).rejects.toThrow(/model.*provider|provider.*model/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('accepts an explicit new Codex provider endpoint with no native provider definition', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'native-config-'));
  try {
    const configPath = join(root, 'config.toml'); await fs.writeFile(configPath, '');
    const result = await nativeConfiguration({ id: 'p', name: 'P', agent: 'codex', version: 1, configPath, provider: 'hyperspace', model: 'custom-model', baseUrl: 'http://localhost:6655/openai/v1', credentialEnv: 'HY_KEY' });
    expect(result.config.model_providers.hyperspace.base_url).toBe('http://localhost:6655/openai/v1');
    expect(result.config.model_providers.hyperspace.env_key).toBe('HY_KEY');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('reads Claude model transport without inheriting hooks or returning credentials as metadata', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'native-config-'));
  try {
    const configPath = join(root, 'settings.json');
    await fs.writeFile(configPath, JSON.stringify({ model: 'user-model', env: { ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'secret-value' }, hooks: { dangerous: true } }));
    const config = await nativeConfiguration({ id: 'p', name: 'P', agent: 'claude', version: 1, configPath });
    expect(config.model).toBe('user-model');
    expect(config.env.ANTHROPIC_AUTH_TOKEN).toBe('secret-value');
    expect(config.public.baseUrl).toBe('https://gateway.example/anthropic');
    expect(JSON.stringify(config.public)).not.toContain('secret-value');
    expect(config.config).not.toHaveProperty('hooks');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it('reads selected OpenCode provider and supports explicit model/endpoint overrides', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'native-config-'));
  try {
    const configPath = join(root, 'opencode.json');
    await fs.writeFile(configPath, JSON.stringify({ model: 'hyperspace/model-a', provider: { hyperspace: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gateway.example/v1', apiKey: '{env:HY_KEY}' }, models: { 'model-a': { name: 'A' } } } }, plugin: ['unsafe-plugin'], mcp: { write: {} } }));
    const config = await nativeConfiguration({ id: 'p', name: 'P', agent: 'opencode', version: 1, configPath, model: 'hyperspace/model-b', baseUrl: 'https://other.example/v1' });
    expect(config.model).toBe('hyperspace/model-b');
    expect(config.config.provider.hyperspace.options.baseURL).toBe('https://other.example/v1');
    expect(config.config).not.toHaveProperty('plugin');
    expect(config.config).not.toHaveProperty('mcp');
    expect(config.public.credentialEnv).toBe('HY_KEY');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('supports OpenCode v2 providers/settings without dropping Hyperspace transport', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'native-config-'));
  try {
    const configPath = join(root, 'opencode.jsonc');
    await fs.writeFile(configPath, JSON.stringify({ model: 'hai-openai/test', providers: { 'hai-openai': { canonical: 'openai', name: 'Hyperspace', settings: { baseURL: 'http://localhost:6655/openai/v1', apiKey: 'local-secret', transport: 'http' }, models: { test: { name: 'Test' } } } } }));
    const result = await nativeConfiguration({ id: 'p', name: 'P', version: 1, agent: 'opencode', configPath });
    expect(result.config.providers['hai-openai'].settings.baseURL).toBe('http://localhost:6655/openai/v1');
    expect(result.public.baseUrl).toBe('http://localhost:6655/openai/v1');
    expect(JSON.stringify(result.public)).not.toContain('local-secret');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it.each(['provider', 'providers'])('discovers locally declared OpenCode %s model names across providers without exposing credentials', async (key) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'native-config-'));
  try {
    const configPath = join(root, 'opencode.json');
    await fs.writeFile(configPath, JSON.stringify({ model: 'alpha/current', [key]: { alpha: { models: { current: { name: 'Current' }, other: { name: 'Other' } }, options: { apiKey: 'secret-one' }, settings: { apiKey: 'secret-two' } }, beta: { models: { next: { name: 'Next' } } } } }));
    const result = await nativeConfiguration({ id: 'p', name: 'P', version: 1, agent: 'opencode', configPath });
    expect(result.models).toEqual(expect.arrayContaining([{ id: 'alpha/current', label: 'Current', provider: 'alpha' }, { id: 'alpha/other', label: 'Other', provider: 'alpha' }, { id: 'beta/next', label: 'Next', provider: 'beta' }]));
    expect(JSON.stringify(result.models)).not.toContain('secret-');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it('discovers current and configured Codex profile models with each provider', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'native-config-'));
  try {
    const configPath = join(root, 'config.toml');
    await fs.writeFile(configPath, `model = "current"
model_provider = "gateway"
[model_providers.gateway]
name = "Gateway"
base_url = "https://gateway.example"
http_headers = { Authorization = "secret-token" }
[profiles.other]
model = "second"
model_provider = "openai"
[profiles.inherited]
model = "third"
`);
    const result = await nativeConfiguration({ id: 'p', name: 'P', version: 1, agent: 'codex', configPath });
    expect(result.models).toEqual([{ id: 'current', label: 'current', provider: 'gateway' }, { id: 'second', label: 'second', provider: 'openai' }, { id: 'third', label: 'third', provider: 'gateway' }]);
    expect(JSON.stringify(result.models)).not.toContain('secret-token');
    const selected = await nativeConfiguration({ id: 'p', name: 'P', version: 1, agent: 'codex', configPath, model: 'second', provider: 'openai' });
    expect(selected.config.model_provider).toBe('openai');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it('discovers Claude current and local model aliases without fabricating a catalog', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'native-config-'));
  try {
    const configPath = join(root, 'settings.json');
    await fs.writeFile(configPath, JSON.stringify({ model: 'current', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet', ANTHROPIC_DEFAULT_OPUS_MODEL: 'custom-opus', ANTHROPIC_AUTH_TOKEN: 'secret-token' } }));
    const result = await nativeConfiguration({ id: 'p', name: 'P', version: 1, agent: 'claude', configPath });
    expect(result.models?.map(model => model.id)).toEqual(['current', 'custom-sonnet', 'custom-opus']);
    expect(JSON.stringify(result.models)).not.toContain('secret-token');
    expect(result.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('custom-sonnet');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('returns and pins the working resolved executable and local model choices', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'native-config-'));
  try {
    const configPath = join(root, 'native.json'); await fs.writeFile(configPath, '{"model":"configured"}');
    const command = join(root, '.local/bin/claude'); await fs.mkdir(join(command, '..'), { recursive: true });
    await fs.writeFile(command, '#!/bin/sh\necho claude-test\n', { mode: 0o755 });
    const profile = { id: 'p', name: 'P', version: 1, agent: 'claude' as const, configPath };
    const options = { home: root, path: '', commonDirectories: [] };
    expect(await detectAgent(profile, options)).toMatchObject({ available: true, command, version: 'claude-test', installations: [{ command, version: 'claude-test' }], models: [{ id: 'configured', provider: 'anthropic' }] });
    expect(await pinProfile(profile, options)).toMatchObject({ command, model: 'configured' });
    const pinned = await pinProfile({ ...profile, command: 'claude' }, { ...options, path: join(root, '.local/bin') });
    expect(pinned.command).toBe(command);
    const alternative = join(root, 'alternative/claude'); await fs.mkdir(join(alternative, '..'));
    await fs.writeFile(alternative, '#!/bin/sh\necho different-claude\n', { mode: 0o755 });
    expect(await detectAgent(pinned, { ...options, path: join(root, 'alternative') })).toMatchObject({ command, version: 'claude-test' });
    expect(await pinProfile({ ...profile, command: join(root, 'missing') }, options)).toMatchObject({ command: join(root, 'missing') });
    expect(await detectAgent({ ...profile, command: join(root, 'missing') }, options)).toMatchObject({ available: false, installations: [] });
    await fs.writeFile(configPath, '{invalid');
    expect(await detectAgent(profile, options)).toMatchObject({ available: true, command, error: expect.any(String) });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('honors the Codex environment executable override while explicit profiles take precedence', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'codex-override-'));
  try {
    const configPath = join(root, 'config.toml'); await fs.writeFile(configPath, 'model = "configured"');
    const fallback = join(root, '.local/bin/codex'); await fs.mkdir(join(fallback, '..'), { recursive: true });
    await fs.writeFile(fallback, '#!/bin/sh\necho fallback\n', { mode: 0o755 });
    const override = join(root, 'custom-codex'); await fs.writeFile(override, '#!/bin/sh\necho override\n', { mode: 0o755 });
    const explicit = join(root, 'selected-codex'); await fs.writeFile(explicit, '#!/bin/sh\necho explicit\n', { mode: 0o755 });
    const profile = { id: 'p', name: 'P', version: 1, agent: 'codex' as const, configPath };
    const options = { home: root, path: join(root, '.local/bin'), commonDirectories: [] };
    vi.stubEnv('AI_PILOT_CODEX_BIN', override);
    expect(await detectAgent(profile, options)).toMatchObject({ available: true, command: override, version: 'override' });
    expect(await pinProfile(profile, options)).toMatchObject({ command: override });
    expect(await detectAgent({ ...profile, command: explicit }, options)).toMatchObject({ available: true, command: explicit, version: 'explicit' });
    expect(await pinProfile({ ...profile, command: explicit }, options)).toMatchObject({ command: explicit });
    const missing = join(root, 'missing'); vi.stubEnv('AI_PILOT_CODEX_BIN', missing);
    expect(await detectAgent(profile, options)).toMatchObject({ available: false, installations: [] });
    expect(await pinProfile(profile, options)).toMatchObject({ command: missing });
    expect(await detectAgent({ ...profile, command: explicit }, options)).toMatchObject({ command: explicit });
    vi.stubEnv('AI_PILOT_CODEX_BIN', override);
    expect(await detectAgent({ ...profile, command: missing }, options)).toMatchObject({ available: false, installations: [] });
    expect(await pinProfile({ ...profile, command: missing }, options)).toMatchObject({ command: missing });
  } finally { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); }
});
