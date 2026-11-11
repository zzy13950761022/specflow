import { z } from 'zod';

export const AgentKindSchema = z.enum(['codex', 'claude', 'opencode']);
const optionalText = z.string().trim().min(1).max(4096).optional();
export const AgentProfileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(100),
  agent: AgentKindSchema,
  version: z.number().int().positive().default(1),
  command: optionalText,
  configPath: optionalText,
  provider: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  baseUrl: z.string().url().refine(value => { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }, 'Use an HTTP(S) endpoint without credentials or query parameters.').optional(),
  credentialEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Enter an environment variable name, not a credential.').optional(),
}).strict();
export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type AgentKind = z.infer<typeof AgentKindSchema>;
export const AgentSettingsSchema = z.object({
  revision: z.number().int().nonnegative().default(0),
  profiles: z.array(AgentProfileSchema).max(30).default([]),
  defaultProfileId: z.string().optional(),
  // Read older settings without retaining repository-specific defaults.
  repoDefaults: z.record(z.string()).optional(),
}).strict().transform(({ repoDefaults: _legacy, ...settings }) => settings).superRefine((settings, context) => {
  const ids = new Set(settings.profiles.map(profile => profile.id));
  if (ids.size !== settings.profiles.length) context.addIssue({ code: 'custom', message: 'Profile IDs must be unique.' });
  if (settings.defaultProfileId && !ids.has(settings.defaultProfileId)) context.addIssue({ code: 'custom', message: 'Default profile does not exist: ' + settings.defaultProfileId });
});
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;
