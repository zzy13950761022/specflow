import { it, expect } from 'vitest';
import { parse } from 'smol-toml';
import { managedModelConfiguration } from './codex-config.js';

it('inherits the selected model transport without MCP, hooks or command policy', () => {
  const result = managedModelConfiguration(`
model = "gpt-6.1-sol"
model_provider = "hyperspace"
approval_policy = "on-request"
sandbox_mode = "danger-full-access"
model_reasoning_effort = "low"
[model_providers.hyperspace]
name = "Local service"
base_url = "http://localhost:6655/openai/v1"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = false
env_http_headers = { Authorization = "LOCAL_PROVIDER_AUTH" }
[model_providers.unused]
base_url = "https://unused.example"
[mcp_servers.ai-pilot]
command = "unsafe-command"
[hooks]
command = "unsafe-hook"
[projects."/tmp/repo"]
trust_level = "trusted"
`);
  expect(result.model).toBe('gpt-6.1-sol');
  expect(result.modelProvider).toBe('hyperspace');
  expect(parse(result.toml)).toEqual({
    model: 'gpt-6.1-sol', model_provider: 'hyperspace', model_reasoning_effort: 'low', approval_policy: 'never',
    model_providers: { hyperspace: { name: 'Local service', base_url: 'http://localhost:6655/openai/v1', wire_api: 'responses', supports_websockets: false, requires_openai_auth: false, env_http_headers: { Authorization: 'LOCAL_PROVIDER_AUTH' } } },
  });
});

it('resolves the selected profile but omits unrelated profile configuration', () => {
  const result = managedModelConfiguration(`
model = "base-model"
profile = "local"
[profiles.local]
model = "profile-model"
model_provider = "local"
sandbox_mode = "danger-full-access"
[model_providers.local]
base_url = "http://localhost:6655/v1"
wire_api = "responses"
`);
  expect(result.model).toBe('profile-model');
  expect(result.modelProvider).toBe('local');
  expect(parse(result.toml)).not.toHaveProperty('profiles');
});

it('keeps default configuration minimal and rejects invalid or undefined providers', () => {
  expect(parse(managedModelConfiguration('').toml)).toEqual({ approval_policy: 'never' });
  expect(() => managedModelConfiguration('model_provider = "missing"')).toThrow(/provider/i);
  expect(() => managedModelConfiguration('malformed = [')).toThrow(/config/i);
});

it('selects an explicitly pinned provider before filtering native provider definitions', () => {
  const source = ['model_provider="first"', '[model_providers.first]', 'base_url="https://first.example/v1"', '[model_providers.second]', 'base_url="https://second.example/v1"', 'wire_api="responses"', 'env_key="SECOND_KEY"'].join(String.fromCharCode(10));
  const result = managedModelConfiguration(source, { model_provider: 'second', model: 'pinned-model' });
  expect(parse(result.toml).model_providers).toEqual({ second: { base_url: 'https://second.example/v1', wire_api: 'responses', env_key: 'SECOND_KEY' } });
  expect(result.model).toBe('pinned-model');
});
