import { it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SpecStore } from './spec-store.js';
import { StageMachine } from './stage-machine.js';
import { AppCore } from './app-core.js';

it('serializes read/mutate/write across independent stores', async () => {
  const repo = await fs.mkdtemp(join(tmpdir(), 'transaction-'));
  try {
    const a = new SpecStore(); const b = new SpecStore();
    await a.write(repo, new StageMachine().createSpec({ ticketId: 'TX-1', title: '0' }));
    await Promise.all([a, b].map((store) => store.transaction(repo, 'TX-1', async (spec) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...spec!, title: String(Number(spec!.title) + 1) };
    })));
    expect((await a.read(repo, 'TX-1'))!.title).toBe('2');
  } finally { await fs.rm(repo, { recursive: true, force: true }); }
});

it('persists pause/resume and recovers interrupted runs without repeating them', async () => {
  const repo = await fs.mkdtemp(join(tmpdir(), 'resume-'));
  const home = await fs.mkdtemp(join(tmpdir(), 'resume-home-'));
  process.env.AI_PILOT_HOME = home;
  try {
    const app = new AppCore(); const { id } = await app.addRepo(repo);
    await app.createSpec(id, 'R-1', 'Resume');
    await app.pauseExecution(id, 'R-1');
    await expect(app.recordAiOutput(id, 'R-1', 'spec', 'Output')).rejects.toThrow(/paused/i);
    expect((await new AppCore().getExecutionStatus(id, 'R-1')).actions).toEqual([]);
    await app.resumeExecution(id, 'R-1');
    expect((await app.getExecutionStatus(id, 'R-1')).actions[0].tool).toBe('get_stage_prompt');
    const spec = (await app.getSpec(id, 'R-1'))!;
    spec.stages[0].activeCheck = { runId: 'interrupted', pid: 2147483647, revision: 0 };
    await app.store.write(repo, spec);
    const recovered = await app.resumeExecution(id, 'R-1');
    expect(recovered.stages[0].activeCheck).toBeUndefined();
    expect(recovered.execution.status).toBe('failed');
    expect(recovered.execution.retryCount).toBe(1);
  } finally { delete process.env.AI_PILOT_HOME; await fs.rm(repo, { recursive: true, force: true }); await fs.rm(home, { recursive: true, force: true }); }
});

it('requires current implementation logs before completing a task', async () => {
  const repo = await fs.mkdtemp(join(tmpdir(), 'log-gate-'));
  const home = await fs.mkdtemp(join(tmpdir(), 'log-home-'));
  process.env.AI_PILOT_HOME = home;
  try {
    const app = new AppCore(); const { id } = await app.addRepo(repo);
    let spec = await app.createSpec(id, 'TX-1', 'Logs');
    for (const stage of ['spec', 'requirements', 'design'] as const) {
      await app.recordAiOutput(id, 'TX-1', stage, 'Approved context');
      await app.approve(id, 'TX-1', stage);
      await app.advance(id, 'TX-1', stage);
    }
    spec = await app.setDevelopSubtasks(id, 'TX-1', [{ description: 'Build' }]);
    await app.recordAiOutput(id, 'TX-1', 'develop', 'Plan');
    await app.approve(id, 'TX-1', 'develop');
    const task = spec.stages[3].subtasks![0];
    await expect(app.setSubtaskCompleted(id, 'TX-1', task.id, true)).rejects.toThrow(/log/i);
    await app.logImplementation(id, 'TX-1', task.id, { summary: 'Done', filesModified: ['src/a.ts'], filesCreated: [], statistics: { linesAdded: 1, linesRemoved: 0 }, artifacts: {} });
    const completed = await app.setSubtaskCompleted(id, 'TX-1', task.id, true);
    expect(completed.stages[3].subtasks![0].completed).toBe(true);
    expect((await app.setSubtaskCompleted(id, 'TX-1', task.id, true)).stages[3].subtasks![0].completed).toBe(true);
  } finally { delete process.env.AI_PILOT_HOME; await fs.rm(repo, { recursive: true, force: true }); await fs.rm(home, { recursive: true, force: true }); }
});
