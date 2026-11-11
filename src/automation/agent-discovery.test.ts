import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it } from 'vitest';
import { discoverInstallations } from './agent-discovery.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() { const home = await fs.mkdtemp(join(tmpdir(), 'agent-discovery-')); roots.push(home); return home; }
async function executable(path: string, body: string) { await fs.mkdir(join(path, '..'), { recursive: true }); await fs.writeFile(path, '#!/bin/sh\n' + body, { mode: 0o755 }); }

it('skips a broken PATH command and selects a valid VS Code Codex installation', async () => {
  const home = await fixture(); const path = join(home, 'bin');
  await executable(join(path, 'codex'), 'exit 1');
  const command = join(home, '.vscode/extensions/openai.chatgpt-1.2.3/bin/macos-aarch64/codex');
  await executable(command, 'echo codex-v1');
  expect(await discoverInstallations('codex', undefined, { home, path, platform: 'darwin', arch: 'arm64', commonDirectories: [] })).toEqual([{ command, label: expect.stringContaining('VS Code'), version: 'codex-v1' }]);
});
it('keeps PATH precedence while listing other valid installations', async () => {
  const home = await fixture(); const path = join(home, 'path');
  await executable(join(path, 'claude'), 'echo first');
  await executable(join(home, '.local/bin/claude'), 'echo second');
  const installations = await discoverInstallations('claude', undefined, { home, path, commonDirectories: [] });
  expect(installations.map(item => item.version)).toEqual(['first', 'second']);
  expect(installations[0].command).toBe(join(path, 'claude'));
});
it('never falls back from an explicit invalid command', async () => {
  const home = await fixture(); await executable(join(home, '.local/bin/codex'), 'echo available');
  expect(await discoverInstallations('codex', join(home, 'missing'), { home, path: '', commonDirectories: [] })).toEqual([]);
});
it('excludes timed out and excessive-output executables', async () => {
  const home = await fixture();
  await executable(join(home, 'slow/codex'), 'exec /bin/sleep 5');
  await executable(join(home, 'noisy/codex'), 'while :; do echo large-output; done');
  expect(await discoverInstallations('codex', undefined, { home, path: join(home, 'slow') + ':' + join(home, 'noisy'), commonDirectories: [], timeoutMs: 30 })).toEqual([]);
});
