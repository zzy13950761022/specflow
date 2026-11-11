import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { delimiter, isAbsolute, join, resolve } from 'path';
import { promisify } from 'util';
import type { AgentKind } from '../core/agent-profile.js';

export interface AgentInstallation { command: string; label: string; version: string }
export interface AgentDiscoveryOptions {
  home?: string;
  path?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  commonDirectories?: string[];
  timeoutMs?: number;
}
const exec = promisify(execFile);

/** Read a bounded directory, never recurse through the user's home. */
async function childDirectories(path: string, prefix = ''): Promise<string[]> {
  const matches: string[] = [];
  try {
    const directory = await fs.opendir(path);
    let inspected = 0;
    for await (const entry of directory) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) matches.push(entry.name);
      if (++inspected >= 512) break;
    }
  } catch { /* An absent conventional install location is normal. */ }
  return matches.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 8).map(name => join(path, name));
}

export async function discoverInstallations(agent: AgentKind, explicitCommand?: string, options: AgentDiscoveryOptions = {}): Promise<AgentInstallation[]> {
  const home = options.home ?? homedir();
  const path = options.path ?? process.env.PATH ?? '';
  const platform = options.platform ?? process.platform;
  const candidates: Array<{ command: string; label: string }> = [];
  const add = (command: string, label: string) => {
    if (!candidates.some(candidate => candidate.command === command)) candidates.push({ command, label });
  };
  if (explicitCommand) {
    if (isAbsolute(explicitCommand) || explicitCommand.includes('/')) add(resolve(explicitCommand), 'Selected executable');
    else {
      // A named explicit command follows normal PATH lookup: a broken first hit is an error.
      for (const directory of path.split(delimiter).slice(0, 32)) {
        const command = resolve(directory || '.', explicitCommand);
        if ((await fs.stat(command).catch(() => null))?.isFile()) { add(command, 'Selected executable'); break; }
      }
    }
  } else {
    for (const directory of path.split(delimiter).filter(Boolean).slice(0, 32)) add(resolve(directory, agent), 'PATH');
    for (const directory of [join(home, '.local/bin'), join(home, '.opencode/bin'), join(home, '.bun/bin'), join(home, '.npm-global/bin'), ...(options.commonDirectories ?? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])]) add(join(directory, agent), 'Local installation');
    for (const directory of await childDirectories(join(home, '.nvm/versions/node'))) add(join(directory, 'bin', agent), 'Node installation');
    if (agent === 'codex' && platform === 'darwin') {
      const architecture = (options.arch ?? process.arch) === 'arm64' ? 'macos-aarch64' : 'macos-x86_64';
      for (const directory of await childDirectories(join(home, '.vscode/extensions'), 'openai.chatgpt-')) add(join(directory, 'bin', architecture, agent), 'VS Code extension');
    }
  }
  const installations: AgentInstallation[] = [];
  const deadline = Date.now() + 8_000;
  for (const candidate of candidates.slice(0, 64)) {
    if (Date.now() >= deadline) break;
    if (!(await fs.stat(candidate.command).catch(() => null))?.isFile()) continue;
    try {
      const result = await exec(candidate.command, ['--version'], { timeout: Math.max(1, Math.min(options.timeoutMs ?? 1_500, deadline - Date.now())), maxBuffer: 32 * 1024, env: { ...process.env, PATH: path } });
      const version = result.stdout.trim().slice(0, 200);
      if (version) installations.push({ ...candidate, version });
    } catch { /* Broken installs must not hide later valid candidates. */ }
  }
  return installations;
}
