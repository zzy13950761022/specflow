import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AgentProfile } from '../core/agent-profile.js';
import { nativeConfiguration } from './agent-detection.js';
import { runHeadless } from './headless-client.js';
import { CodexClient } from './codex-client.js';

export interface AgentTurn {
  profile: AgentProfile; cwd: string; runtime: string; prompt: string; schema: object;
  signal: AbortSignal; sessionId?: string; writable?: boolean; skillPath?: string;
  authPath?: string; timeoutMs?: number;
  onPid?: (pid: number) => Promise<void>; onSession?: (session: string) => Promise<void>;
}
export async function runAgentTurn(turn: AgentTurn): Promise<{ text: string; sessionId: string }> {
  const profile = turn.profile;
  const config = await nativeConfiguration(profile);
  if (profile.credentialEnv && !process.env[profile.credentialEnv]) throw new Error('Configured credential environment variable is missing.');
  await fs.mkdir(turn.runtime, { recursive: true, mode: 0o700 });
  const env = config.env;
  if (profile.agent === 'codex') {
    await fs.writeFile(join(turn.runtime, 'config.toml'), config.toml!, { mode: 0o600 });
    const authSource = turn.authPath ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
    try { await fs.copyFile(authSource, join(turn.runtime, 'auth.json')); await fs.chmod(join(turn.runtime, 'auth.json'), 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const client = new CodexClient(profile.command ?? process.env.AI_PILOT_CODEX_BIN ?? 'codex', ['app-server', '--listen', 'stdio://'], turn.cwd, { ...env, CODEX_HOME: turn.runtime });
    try {
      const starting = client.start();
      void starting.catch(() => {});
      if (client.pid) await turn.onPid?.(client.pid);
      await starting;
      const sessionId = await client.thread(turn.cwd, turn.sessionId, { model: config.model, modelProvider: config.provider });
      await turn.onSession?.(sessionId);
      const text = await client.turn(sessionId, turn.cwd, turn.prompt, turn.writable ?? false, turn.schema, turn.signal, turn.skillPath, turn.timeoutMs);
      return { text, sessionId };
    } finally { await client.close(); }
  }
  if (profile.agent === 'claude') {
    env.CLAUDE_CONFIG_DIR = turn.runtime;
    env.DISABLE_AUTOUPDATER = '1';
    delete env.CLAUDECODE;
  } else {
    const configuration = { ...config.config, permission: { '*': 'deny', read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny' }, glob: 'allow', grep: 'allow', list: 'allow', external_directory: 'deny' }, autoupdate: false, share: 'disabled' };
    const configPath = join(turn.runtime, 'opencode.json');
    await fs.writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 });
    Object.assign(env, { OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: turn.runtime, OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration), OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_CONFIG_PROJECT_DISABLE: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true', XDG_CONFIG_HOME: join(turn.runtime, 'config'), XDG_DATA_HOME: join(turn.runtime, 'data'), XDG_CACHE_HOME: join(turn.runtime, 'cache'), XDG_STATE_HOME: join(turn.runtime, 'state') });
    const authSource = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'auth.json');
    try {
      const auth = JSON.parse(await fs.readFile(authSource, 'utf8'));
      if (config.provider && auth[config.provider]) { const directory = join(turn.runtime, 'data', 'opencode'); await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.writeFile(join(directory, 'auth.json'), JSON.stringify({ [config.provider]: auth[config.provider] }), { mode: 0o600 }); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read the native OpenCode authentication file.'); }
  }
  return runHeadless({ ...turn, agent: profile.agent, command: profile.command ?? profile.agent, model: config.model, env });
}
