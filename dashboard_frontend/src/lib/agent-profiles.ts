import { AGENT_LABELS, type AgentProfile } from '../types';

function hasAutomaticName(profile: AgentProfile) {
  return !profile.name.trim() || profile.name === 'New profile' || profile.name === AGENT_LABELS[profile.agent];
}

export function configurationLabel(profile: AgentProfile): string {
  const agent = AGENT_LABELS[profile.agent];
  const prefix = hasAutomaticName(profile) ? agent : profile.name + ' · ' + agent;
  return prefix + ' · ' + (profile.model || 'Local current model');
}

export function changeAgent(profile: AgentProfile, agent: AgentProfile['agent']): AgentProfile {
  return { id: profile.id, version: profile.version, agent, name: hasAutomaticName(profile) ? AGENT_LABELS[agent] : profile.name };
}

export function useLocalModel(profile: AgentProfile): AgentProfile {
  const { model, provider, baseUrl, credentialEnv, ...local } = profile;
  return local;
}

export function useConfiguredModel(profile: AgentProfile, choice: { id: string; label: string; provider?: string }): AgentProfile {
  return { ...useLocalModel(profile), model: choice.id, provider: choice.provider };
}

export function useCustomModel(profile: AgentProfile, model: string): AgentProfile {
  if (profile.agent !== 'opencode') return { ...profile, model: model || undefined };
  const provider = model.includes('/') ? model.split('/')[0] : undefined;
  const previous = profile.provider || (profile.model?.includes('/') ? profile.model.split('/')[0] : undefined);
  return { ...(provider === previous ? profile : useLocalModel(profile)), model: model || undefined, provider };
}
