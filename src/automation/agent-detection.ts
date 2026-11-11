import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parse, stringify } from 'smol-toml';
import type { AgentProfile } from '../core/agent-profile.js';
import { AgentProfileSchema } from '../core/agent-profile.js';
import { managedModelConfiguration } from './codex-config.js';
import { discoverInstallations, type AgentDiscoveryOptions, type AgentInstallation } from './agent-discovery.js';

export interface NativeMetadata { configPath?: string; provider?: string; model?: string; baseUrl?: string; credentialEnv?: string }
export interface AgentModelChoice { id: string; label: string; provider?: string }
export interface AgentDetection extends NativeMetadata { available: boolean; error?: string; version?: string; command?: string; installations?: AgentInstallation[]; models?: AgentModelChoice[] }
const transportNames = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_MODEL'];
function parseJsonc(source: string) {
  let output = '', quoted = false, escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char.charCodeAt(0) === 92) escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; output += char; }
    else if (char === '/' && source[i + 1] === '/') {
      while (i + 1 < source.length && ![10, 13].includes(source.charCodeAt(i + 1))) i++;
    } else if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('Unclosed configuration comment.');
      i = end + 1; output += ' ';
    } else output += char;
  }
  let clean = ''; quoted = false; escaped = false;
  for (let i = 0; i < output.length; i++) {
    const char = output[i];
    if (!quoted && char === ',') {
      let next = i + 1; while (next < output.length && output[next].trim() === '') next++;
      if (output[next] === '}' || output[next] === ']') continue;
    }
    clean += char;
    if (escaped) escaped = false;
    else if (quoted && char.charCodeAt(0) === 92) escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  return JSON.parse(clean);
}
async function sourceFile(profile: AgentProfile): Promise<{ path: string; text: string }> {
  const fallback = profile.agent === 'codex' ? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml') : profile.agent === 'claude' ? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json') : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode', 'opencode.json');
  let path = profile.configPath ?? fallback;
  if (!profile.configPath && profile.agent === 'opencode' && !await fs.stat(path).catch(() => null) && await fs.stat(path + 'c').catch(() => null)) path += 'c';
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Native configuration must be a file under 1 MB.');
    return { path, text: await fs.readFile(path, 'utf8') };
  } catch (error) {
    if (!profile.configPath && (error as NodeJS.ErrnoException).code === 'ENOENT') return { path, text: profile.agent === 'codex' ? '' : '{}' };
    throw new Error('Cannot read the selected native configuration file.');
  }
}
function safeEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString().endsWith('/') ? url.toString().slice(0, -1) : url.toString(); } catch { return undefined; }
}
export async function nativeConfiguration(profile: AgentProfile) {
  const source = await sourceFile(profile);
  const env = { ...process.env };
  const models: AgentModelChoice[] = [];
  const addModel = (id: unknown, provider: unknown, label?: unknown) => {
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || typeof provider !== 'string' || !provider || provider.length > 200) return;
    if (!models.some(choice => choice.id === id && choice.provider === provider)) models.push({ id, label: typeof label === 'string' && label.trim() ? label.slice(0, 200) : id, provider });
  };
  let config: Record<string, any> = {}, model = profile.model, provider = profile.provider, baseUrl = profile.baseUrl, credentialEnv = profile.credentialEnv;
  try {
    if (profile.agent === 'codex') {
      const native = parse(source.text) as Record<string, any>;
      if (profile.provider && profile.baseUrl) {
        native.model_providers ??= {};
        native.model_providers[profile.provider] ??= { name: profile.provider, base_url: profile.baseUrl, wire_api: 'responses', requires_openai_auth: false };
      }
      config = parse(managedModelConfiguration(stringify(native), { ...(profile.model ? { model: profile.model } : {}), ...(profile.provider ? { model_provider: profile.provider } : {}) }).toml);
      model ??= config.model;
      provider ??= config.model_provider ?? 'openai';
      let transport = config.model_providers?.[provider!];
      if (baseUrl && !transport) transport = { name: provider, wire_api: 'responses', requires_openai_auth: false };
      if (transport) {
        if (baseUrl) transport.base_url = baseUrl;
        if (credentialEnv) transport.env_key = credentialEnv;
        baseUrl ??= transport.base_url;
        credentialEnv ??= transport.env_key ?? transport.env_http_headers?.Authorization;
        config.model_providers = { [provider!]: transport };
      }
      if (model) config.model = model;
      config.model_provider = provider;
      addModel(model, provider);
      for (const configured of Object.values(native.profiles ?? {}) as Array<Record<string, any>>) {
        addModel(configured?.model ?? native.model, configured?.model_provider ?? native.model_provider ?? 'openai');
      }
    } else if (profile.agent === 'claude') {
      const native = parseJsonc(source.text);
      for (const name of transportNames) if (typeof native.env?.[name] === 'string') env[name] = native.env[name];
      model ??= native.model ?? env.ANTHROPIC_MODEL;
      baseUrl ??= env.ANTHROPIC_BASE_URL;
      if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
      if (credentialEnv) {
        if (!process.env[credentialEnv]) throw new Error('Configured credential environment variable is missing.');
        env.ANTHROPIC_AUTH_TOKEN = process.env[credentialEnv];
        env.ANTHROPIC_API_KEY = process.env[credentialEnv];
      }
      provider ??= baseUrl ? 'hyperspace' : 'anthropic';
      if (model) env.ANTHROPIC_MODEL = model;
      addModel(model, provider);
      for (const [name, value] of Object.entries(native.env ?? {})) {
        if (/^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/.test(name) && typeof value === 'string') {
          env[name] = value;
          addModel(value, provider);
        }
      }
    } else {
      const native = parseJsonc(source.text);
      model ??= native.model;
      provider ??= model?.includes('/') ? model.split('/')[0] : 'hyperspace';
      if (model?.includes('/') && model.split('/')[0] !== provider) throw new Error('OpenCode model provider differs from the selected Provider. Use provider/model with matching names.');
      if (model && !model.includes('/')) model = provider + '/' + model;
      const v2 = !!native.providers;
      const sourceProvider = (v2 ? native.providers?.[provider!] : native.provider?.[provider!]) ?? {};
      if (sourceProvider.npm && !['@ai-sdk/openai', '@ai-sdk/openai-compatible', '@ai-sdk/anthropic', '@ai-sdk/amazon-bedrock', '@ai-sdk/google'].includes(sourceProvider.npm)) throw new Error('This provider SDK is not supported in managed execution.');
      const options = { ...(v2 ? sourceProvider.settings : sourceProvider.options) };
      if (baseUrl) options.baseURL = baseUrl;
      if (credentialEnv) options.apiKey = '{env:' + credentialEnv + '}';
      baseUrl ??= options.baseURL;
      credentialEnv ??= typeof options.apiKey === 'string' && options.apiKey.startsWith('{env:') && options.apiKey.endsWith('}') ? options.apiKey.slice(5, -1) : undefined;
      const modelId = model?.slice(model.indexOf('/') + 1).split('#')[0];
      const models = modelId ? { [modelId]: sourceProvider.models?.[modelId] ?? { name: modelId } } : {};
      // Leave native built-in providers intact (including Hyperspace-enabled distributions).
      const custom = sourceProvider.canonical || sourceProvider.npm || sourceProvider.package || Object.keys(options).length || Object.keys(sourceProvider.models ?? {}).length;
      if (v2 && sourceProvider.package && !['@ai-sdk/openai', '@ai-sdk/openai-compatible', '@ai-sdk/anthropic', '@ai-sdk/amazon-bedrock', '@ai-sdk/google'].includes(sourceProvider.package)) throw new Error('This provider SDK is not supported in managed execution.');
      config = { ...(model ? { model } : {}), ...(custom ? v2
        ? { providers: { [provider!]: { ...sourceProvider, settings: options, models } } }
        : { provider: { [provider!]: { npm: sourceProvider.npm ?? '@ai-sdk/openai-compatible', options, models } } } : {}) };
      addModel(model, provider, sourceProvider.models?.[modelId!]?.name);
      for (const [name, configured] of Object.entries(native.providers ?? native.provider ?? {}) as Array<[string, Record<string, any>]>) {
        for (const [id, details] of Object.entries(configured?.models ?? {}) as Array<[string, Record<string, any>]>) addModel(name + '/' + id, name, details?.name);
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Cannot parse native model configuration.');
    throw error;
  }
  const metadata: NativeMetadata = { configPath: profile.configPath, model, provider, baseUrl: safeEndpoint(baseUrl), credentialEnv };
  return { config, toml: profile.agent === 'codex' ? stringify(config) : undefined, env, model, provider, models, public: metadata };
}
export async function detectAgent(profile: AgentProfile, options?: AgentDiscoveryOptions): Promise<AgentDetection> {
  const command = profile.command ?? (profile.agent === 'codex' ? process.env.AI_PILOT_CODEX_BIN : undefined);
  const installations = await discoverInstallations(profile.agent, command, options);
  const selected = installations[0];
  if (!selected) return { available: false, installations, error: 'Executable unavailable. Set its absolute path and check installation.' };
  const result = { available: true, version: selected.version, command: selected.command, installations };
  try { const native = await nativeConfiguration(profile); return { ...result, ...native.public, models: native.models }; }
  catch { return { ...result, error: 'Executable found, but native configuration could not be read. Check the file and provider settings.' }; }
}
export async function pinProfile(profile: AgentProfile, options?: AgentDiscoveryOptions): Promise<AgentProfile> {
  const command = profile.command ?? (profile.agent === 'codex' ? process.env.AI_PILOT_CODEX_BIN : undefined);
  const selected = (await discoverInstallations(profile.agent, command, options))[0];
  return AgentProfileSchema.parse({ ...profile, command: selected?.command ?? command, ...(await nativeConfiguration(profile)).public });
}
