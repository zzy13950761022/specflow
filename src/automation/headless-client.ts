import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { processGroupAlive } from '../core/processes.js';

export interface HeadlessOptions {
  agent: 'claude' | 'opencode'; command: string; cwd: string; runtime: string;
  prompt: string; schema: object; env: NodeJS.ProcessEnv; signal: AbortSignal;
  model?: string; sessionId?: string; timeoutMs?: number;
  onPid?: (pid: number) => Promise<void>; onSession?: (session: string) => Promise<void>;
}

/** Native print/run interfaces use read tools; the host applies validated source changes. */
export async function runHeadless(options: HeadlessOptions): Promise<{ text: string; sessionId: string }> {
  if (options.signal.aborted) throw new Error('Agent turn cancelled.');
  const args = options.agent === 'claude' ? [
    '--print', '--verbose', '--output-format', 'stream-json', '--json-schema', JSON.stringify(options.schema),
    '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep',
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
    ...(options.sessionId ? ['--resume', options.sessionId] : ['--session-id', randomUUID()]),
    ...(options.model ? ['--model', options.model] : []),
  ] : ['run', '--standalone', '--format', 'json', ...(options.model ? ['--model', options.model] : []), ...(options.sessionId ? ['--session', options.sessionId] : [])];
  const prompt = options.agent === 'opencode' ? options.prompt + String.fromCharCode(10) + 'Return only one JSON object matching this schema: ' + JSON.stringify(options.schema) : options.prompt;
  const child = spawn(options.command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let failure: Error | undefined, bytes = 0, text = '', sessionId = options.sessionId ?? '', gotResult = false;
  let sessionWrite = Promise.resolve();
  const exited = new Promise<number | null>((resolve) => { child.once('close', resolve); child.once('error', () => resolve(null)); });
  const kill = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* already stopped */ } } };
  const fail = (error: Error) => { failure ??= error; kill('SIGTERM'); };
  child.on('error', () => fail(new Error('Cannot start ' + options.agent + '. Check the configured executable.')));
  child.stdin.on('error', () => fail(new Error('Agent input stream closed.')));
  const abort = () => fail(new Error('Agent turn cancelled.'));
  options.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => fail(new Error('Agent turn timed out.')), options.timeoutMs ?? 15 * 60_000);
  const killer = setInterval(() => { if (failure) kill('SIGKILL'); }, 500);
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) fail(new Error('Agent output limit exceeded.')); });
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) fail(new Error('Agent output limit exceeded.')); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (!line.trim() || failure) return;
    try {
      const event = JSON.parse(line);
      const nativeId = event.session_id ?? event.sessionID;
      if (typeof nativeId === 'string' && nativeId !== sessionId) { sessionId = nativeId; sessionWrite = sessionWrite.then(() => options.onSession?.(nativeId)).catch(error => fail(error)); }
      if (event.type === 'error' || event.type?.startsWith('permission') || event.is_error) throw new Error('Agent could not complete the turn. Check model access and permission configuration.');
      if (options.agent === 'claude' && event.type === 'result') {
        if (event.subtype !== 'success') throw new Error('Agent returned an unsuccessful result.');
        text = event.structured_output ? JSON.stringify(event.structured_output) : event.result; gotResult = true;
      }
      if (options.agent === 'opencode' && event.type === 'text' && typeof event.part?.text === 'string') text = event.part.text;
      if (options.agent === 'opencode' && event.type === 'step_finish' && event.part?.reason === 'stop') gotResult = true;
    } catch (error) { fail(error instanceof SyntaxError ? new Error('Agent returned invalid JSON output.') : error as Error); }
  });
  try {
    if (child.pid) await options.onPid?.(child.pid);
    if (options.signal.aborted) abort();
    if (!failure) child.stdin.end(prompt);
    const code = await exited;
    await sessionWrite;
    if (failure) throw failure;
    if (code !== 0 || !gotResult || !sessionId || !text) throw new Error('Agent exited without a complete result. Check the model and native configuration.');
    const fence = String.fromCharCode(96).repeat(3);
    const trimmed = text.trim();
    const normalized = trimmed.startsWith(fence) && trimmed.endsWith(fence) ? trimmed.slice(trimmed.indexOf(String.fromCharCode(10)) + 1, -3).trim() : trimmed;
    JSON.parse(normalized);
    return { text: normalized, sessionId };
  } finally {
    clearTimeout(timer); clearInterval(killer); options.signal.removeEventListener('abort', abort); lines.close();
    kill('SIGTERM');
    const deadline = Date.now() + 1000;
    while (processGroupAlive(child.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (processGroupAlive(child.pid)) kill('SIGKILL');
    await exited;
    const killDeadline = Date.now() + 2000;
    while (processGroupAlive(child.pid) && Date.now() < killDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (processGroupAlive(child.pid)) throw new Error('Agent subprocess is still alive. Stop it before retrying.');
  }
}
