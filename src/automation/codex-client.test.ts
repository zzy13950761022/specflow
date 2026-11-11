import { it, expect } from 'vitest';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { CodexClient } from './codex-client.js';
import { promises as fs } from 'fs';
import { join } from 'path';

it('initializes, preserves thread ID, uses a bounded turn, and closes the subprocess', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url));
  const client = new CodexClient(process.execPath, [fixture], tmpdir());
  try {
    await client.start(); expect(await client.thread(tmpdir())).toBe('thread-one');
    const result = await client.turn('thread-one', tmpdir(), 'Read the repo', false, { type: 'object' }, new AbortController().signal);
    expect(JSON.parse(result)).toEqual({ content: 'result' });
    expect(await client.thread(tmpdir(), 'thread-one')).toBe('thread-one');
  } finally { await client.close(); }
});
it('fails promptly when the binary is missing', async () => {
  const client = new CodexClient('/nonexistent/codex', [], tmpdir());
  await expect(client.start()).rejects.toThrow(); await client.close();
});
it('applies the model provider when starting and resuming a persisted thread', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url));
  const client = new CodexClient(process.execPath, [fixture], tmpdir(), { ...process.env, PILOT_FIXTURE_MODE: 'provider' });
  try {
    await client.start();
    expect(await client.thread(tmpdir(), undefined, { model: 'local-model', modelProvider: 'hyperspace' })).toBe('thread-one');
    expect(await client.thread(tmpdir(), 'thread-one', { model: 'local-model', modelProvider: 'hyperspace' })).toBe('thread-one');
  } finally { await client.close(); }
});
it('cancels a stalled turn and terminates its process', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url));
  const client = new CodexClient(process.execPath, [fixture], tmpdir(), { ...process.env, PILOT_FIXTURE_MODE: 'hang' });
  try {
    await client.start(); const thread = await client.thread(tmpdir()); const controller = new AbortController();
    const turn = client.turn(thread, tmpdir(), 'Task', false, {}, controller.signal);
    setTimeout(() => controller.abort(), 20); await expect(turn).rejects.toThrow(/cancelled/i);
  } finally { await client.close(); }
});
it('rejects malformed transport output instead of treating it as a task result', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url));
  const client = new CodexClient(process.execPath, [fixture], tmpdir(), { ...process.env, PILOT_FIXTURE_MODE: 'invalid' });
  try { await client.start(); const thread = await client.thread(tmpdir()); await expect(client.turn(thread, tmpdir(), 'Task', false, {}, new AbortController().signal)).rejects.toThrow(/invalid/i); }
  finally { await client.close(); }
});
it('cleanup terminates a tool descendant even when it ignores SIGTERM', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'codex-process-group-')); const pidFile = join(dir, 'child.pid');
  const fixture = fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url));
  const client = new CodexClient(process.execPath, [fixture], tmpdir(), { ...process.env, PILOT_FIXTURE_MODE: 'descendant', PILOT_FIXTURE_PID_FILE: pidFile });
  let pid: number | undefined;
  try {
    await client.start(); pid = Number(await fs.readFile(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.close(); expect(() => process.kill(pid!, 0)).toThrow();
  } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } await client.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
