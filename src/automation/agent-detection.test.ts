import { expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { nativeConfiguration } from './agent-detection.js';

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
