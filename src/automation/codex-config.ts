import { parse, stringify } from 'smol-toml';
import { z } from 'zod';

const modelSchema = z.object({
  model: z.string().min(1).optional(), model_provider: z.string().min(1).optional(),
  model_reasoning_effort: z.string().optional(), model_reasoning_summary: z.string().optional(),
  model_verbosity: z.string().optional(),
});
const providerSchema = z.object({
  name: z.string().optional(), base_url: z.string().optional(), wire_api: z.string().optional(),
  env_key: z.string().optional(), env_key_instructions: z.string().optional(),
  http_headers: z.record(z.string()).optional(), env_http_headers: z.record(z.string()).optional(),
  request_max_retries: z.number().int().nonnegative().optional(),
  stream_max_retries: z.number().int().nonnegative().optional(),
  stream_idle_timeout_ms: z.number().int().positive().optional(),
  supports_websockets: z.boolean().optional(), requires_openai_auth: z.boolean().optional(),
});

/** Copy only model transport settings; unrelated user configuration never enters managed runs. */
export function managedModelConfiguration(source: string): { toml: string; model?: string; modelProvider: string } {
  let config: Record<string, any>;
  try { config = parse(source); } catch { throw new Error('Cannot parse Codex configuration. Inspect the user config.toml.'); }
  let profile = {};
  if (config.profile !== undefined) {
    if (typeof config.profile !== 'string' || !config.profiles?.[config.profile]) throw new Error('Selected Codex configuration profile is missing.');
    profile = config.profiles[config.profile];
  }
  const result = modelSchema.safeParse({ ...config, ...profile });
  if (!result.success) throw new Error('Invalid Codex model configuration.');
  const model = result.data;
  const modelProvider = model.model_provider ?? 'openai';
  const provider = config.model_providers?.[modelProvider];
  const output: Record<string, any> = { ...model, approval_policy: 'never' };
  if (provider !== undefined) {
    const parsed = providerSchema.safeParse(provider);
    if (!parsed.success) throw new Error('Invalid selected Codex model provider configuration.');
    output.model_providers = { [modelProvider]: parsed.data };
  } else if (modelProvider !== 'openai') throw new Error('Selected Codex model provider is missing from config.toml.');
  return { toml: stringify(output), model: model.model, modelProvider };
}
