import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
if (process.env.PILOT_FIXTURE_MODE === 'descendant') {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.PILOT_FIXTURE_PID_FILE, String(child.pid));
}
const send = (x) => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10));
createInterface({ input: process.stdin }).on('line', (line) => {
  const x = JSON.parse(line);
  if (x.id === undefined) return;
  if (x.method === 'initialize') send({ id: x.id, result: {} });
  else if (x.method === 'thread/start' || x.method === 'thread/resume') {
    if (process.env.PILOT_FIXTURE_MODE === 'provider' && (x.params.modelProvider !== 'hyperspace' || x.params.model !== 'local-model')) {
      send({ id: x.id, error: { message: 'Expected selected model provider on thread start/resume.' } });
    } else send({ id: x.id, result: { thread: { id: 'thread-one' } } });
  }
  else if (x.method === 'turn/start') {
    if (process.env.PILOT_FIXTURE_MODE === 'hang') { send({ id: x.id, result: { turn: { id: 'turn-one' } } }); return; }
    if (process.env.PILOT_FIXTURE_MODE === 'invalid') { process.stdout.write('not-json' + String.fromCharCode(10)); return; }
    if (process.env.PILOT_FIXTURE_MODE === 'workflow') {
      const prompt = x.params.input[0].text;
      let output;
      if (prompt.includes('Implement this claimed task:')) {
        writeFileSync(join(x.params.cwd, 'source.ts'), 'export const implemented = true;');
        output = { summary: 'Implemented acceptance criterion AC-1' };
      } else {
        output = { content: 'Generated stage artifact', subtasks: [], acceptanceCriteria: [], logsSanitized: true, checklistItems: [] };
        if (prompt.includes('; stage: spec;')) output.acceptanceCriteria = [{ id: 'AC-1', given: 'a repository', when: 'implemented', then: 'source exists' }];
        if (prompt.includes('; stage: develop;')) output.subtasks = [{ id: 'A', description: 'Implement source', dependsOn: [], files: ['source.ts'], requirementRef: 'AC-1', testRefs: [] }];
      }
      send({ id: x.id, result: { turn: { id: 'turn-one' } } });
      send({ method: 'turn/completed', params: { threadId: x.params.threadId, turn: { id: 'turn-one', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(output) }] } } });
      return;
    }
    send({ id: x.id, result: { turn: { id: 'turn-one' } } });
    send({ method: 'item/completed', params: { threadId: x.params.threadId, turnId: 'turn-one', item: { type: 'agentMessage', id: 'message', phase: 'final_answer', text: JSON.stringify({ content: 'result' }) } } });
    send({ method: 'turn/completed', params: { threadId: x.params.threadId, turn: { id: 'turn-one', status: 'completed', items: [] } } });
  }
  else if (x.method === 'turn/interrupt') send({ id: x.id, result: {} });
});
