import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { processGroupAlive } from '../core/processes.js';

type Frame = { id?: number | string; method?: string; params?: any; result?: any; error?: { message: string; code?: number } };
/** JSON-RPC stdio subset verified against Codex 0.164 generated App Server bindings. */
export class CodexClient {
  private child?: ChildProcessWithoutNullStreams;
  private serial = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(frame: Frame) => void>();
  private failure?: Error;
  constructor(private command: string, private args: string[], private cwd: string, private env = process.env, private timeoutMs = 30_000) {}
  get pid(): number | undefined { return this.child?.pid; }
  async start(): Promise<void> {
    if (process.platform === 'win32') throw new Error('Managed Codex process cleanup currently requires macOS or Linux.');
    this.child = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.child.on('error', (error) => this.fail(error));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('exit', (code) => this.fail(new Error('Codex App Server exited (' + code + ').')));
    this.child.stderr.resume();
    let bytes = 0;
    this.child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { this.fail(new Error('Codex output exceeded the run limit.')); this.child?.stdout.pause(); } });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      try {
        const frame = JSON.parse(line) as Frame;
        if (frame.method && frame.id !== undefined) {
          this.send({ id: frame.id, error: { code: -32601, message: 'Interactive requests are unavailable in managed runs.' } });
          this.fail(new Error('Codex requested interactive permission. Run this operation manually or adjust repository checks.'));
        } else if (typeof frame.id === 'number') {
          const waiting = this.pending.get(frame.id);
          if (waiting) { clearTimeout(waiting.timer); this.pending.delete(frame.id); frame.error ? waiting.reject(new Error(frame.error.message)) : waiting.resolve(frame.result); }
        } else for (const listener of this.listeners) listener(frame);
      } catch { this.fail(new Error('Invalid Codex JSON-RPC output.')); this.child?.stdout.pause(); }
    });
    await this.request('initialize', { clientInfo: { name: 'specflow_runner', title: 'AI Pilot', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  private send(frame: Frame): void { if (!this.child?.stdin.writable) throw new Error('Codex transport is closed.'); this.child.stdin.write(JSON.stringify(frame) + String.fromCharCode(10)); }
  private fail(error: Error): void {
    this.failure ??= error;
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: 'transport/error', error: { message: error.message } });
  }
  private request(method: string, params: unknown): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex RPC timeout: ' + method)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async thread(cwd: string, threadId?: string, model: { model?: string; modelProvider?: string } = {}): Promise<string> {
    const result = await this.request(threadId ? 'thread/resume' : 'thread/start', { ...(threadId ? { threadId } : {}), ...model, cwd, approvalPolicy: 'never', sandbox: 'read-only' });
    if (typeof result?.thread?.id !== 'string') throw new Error('Codex did not return a thread ID.');
    return result.thread.id;
  }
  async turn(threadId: string, cwd: string, prompt: string, writable: boolean, outputSchema: unknown, signal: AbortSignal, skillPath?: string, timeoutMs = 15 * 60_000): Promise<string> {
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      let turnId: string | undefined; let finalText = ''; let finished = false;
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(listener); signal.removeEventListener('abort', abort); };
      const finish = (error?: Error) => { if (finished) return; finished = true; cleanup(); error ? reject(error) : resolve(finalText); };
      const abort = () => { if (turnId) void this.request('turn/interrupt', { threadId, turnId }).catch(() => {}); finish(new Error('Codex turn cancelled.')); };
      const timer = setTimeout(abort, timeoutMs);
      const listener = (frame: Frame) => {
        if (frame.method === 'transport/error') { finish(new Error(frame.error?.message)); return; }
        const params = frame.params;
        if (params?.threadId !== threadId || (turnId && params.turnId && params.turnId !== turnId)) return;
        if (frame.method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.phase !== 'commentary') finalText = params.item.text;
        if (frame.method === 'turn/completed') {
          if (turnId && params.turn.id !== turnId) return;
          const message = params.turn.items?.filter((item: any) => item.type === 'agentMessage' && item.phase !== 'commentary').at(-1);
          if (message) finalText = message.text;
          finish(params.turn.status === 'completed' && finalText ? undefined : new Error(params.turn.error?.message ?? 'Codex turn failed or returned no structured result.'));
        }
      };
      this.listeners.add(listener); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      const input = [{ type: 'text', text: prompt, text_elements: [] }, ...(skillPath ? [{ type: 'skill', name: 'specflow', path: skillPath }] : [])];
      void this.request('turn/start', { threadId, cwd, input, approvalPolicy: 'never', sandboxPolicy: writable ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } : { type: 'readOnly', networkAccess: false }, outputSchema }).then((result) => { turnId = result.turn.id; }, (error) => finish(error));
    });
  }
  async close(): Promise<void> {
    const child = this.child;
    if (!child?.pid || !processGroupAlive(child.pid)) return;
    const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
    const wait = async (ms: number) => { const deadline = Date.now() + ms; while (processGroupAlive(child.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20)); };
    kill('SIGTERM'); await wait(2000);
    if (processGroupAlive(child.pid)) { kill('SIGKILL'); await wait(2000); }
    if (processGroupAlive(child.pid)) throw new Error('Codex process group is still alive. Stop it before retrying.');
  }
}
