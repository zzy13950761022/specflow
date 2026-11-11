import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runHeadless } from './headless-client.js';
let root: string, command: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'headless-agent-')); command = join(root, 'agent');
  await fs.writeFile(command, '#!' + process.execPath + '\n' + `
    let input = ''; process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const args = process.argv.slice(2);
      if (process.env.FIXTURE === 'hang') { setInterval(()=>{},100); return; }
      if (process.env.FIXTURE === 'invalid') { console.log('invalid'); return; }
      if (args.includes('--print')) {
        console.log(JSON.stringify({type:'system',subtype:'init',session_id:'claude-session'}));
        console.log(JSON.stringify({type:'result',subtype:'success',session_id:'claude-session',structured_output:{content:input, resumed:args.includes('--resume')},is_error:false}));
      } else {
        console.log(JSON.stringify({type:'text',sessionID:'opencode-session',part:{text:'Reading the repository now.'}}));
        console.log(JSON.stringify({type:'step_finish',sessionID:'opencode-session',part:{reason:'tool-calls'}}));
        console.log(JSON.stringify({type:'text',sessionID:'opencode-session',part:{text:JSON.stringify({content:input,resumed:args.includes('--session')})}}));
        console.log(JSON.stringify({type:'step_finish',sessionID:'opencode-session',part:{reason:'stop'}}));
      }
    });`, { mode: 0o700 });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
for (const agent of ['claude', 'opencode'] as const) {
  it(agent + ' returns the native session and resumes it with a bounded structured turn', async () => {
    const options = { agent, command, cwd: root, runtime: root, prompt: 'Read the current task.', schema: { type: 'object' }, env: process.env, signal: new AbortController().signal };
    const first = await runHeadless(options);
    expect(first.sessionId).toBe(agent + '-session');
    const next = await runHeadless({ ...options, sessionId: first.sessionId });
    expect(JSON.parse(next.text).resumed).toBe(true);
  });
}
it('rejects malformed output and cancels the owned process', async () => {
  const options = { agent: 'claude' as const, command, cwd: root, runtime: root, prompt: 'hello', schema: {}, env: { ...process.env, FIXTURE: 'invalid' }, signal: new AbortController().signal };
  await expect(runHeadless(options)).rejects.toThrow(/JSON|output/i);
  const controller = new AbortController();
  let pid: number | undefined;
  const pending = runHeadless({ ...options, env: { ...process.env, FIXTURE: 'hang' }, signal: controller.signal, onPid: async value => { pid = value; controller.abort(); } });
  await expect(pending).rejects.toThrow(/cancel/i);
  expect(() => process.kill(pid!, 0)).toThrow();
});
