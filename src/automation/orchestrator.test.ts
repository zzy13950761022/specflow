import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppCore } from '../core/app-core.js';
import { Orchestrator } from './orchestrator.js';

let app: AppCore, repo: string, id: string;
beforeEach(async () => { repo = await fs.mkdtemp(join(tmpdir(), 'orchestrator-')); process.env.AI_PILOT_HOME = join(repo, '.specflow', 'registry'); app = new AppCore(); id = (await app.addRepo(repo)).id; });
afterEach(async () => { delete process.env.AI_PILOT_HOME; await fs.rm(repo, { recursive: true, force: true }); });
const wait = async (check: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('Timed out'); };

it('runs creation once, parks for review, and resumes on Dashboard approval', async () => {
  let runs = 0;
  const service = new Orchestrator(app, async (repoId, ticketId, runId) => {
    runs++; const spec = (await app.getSpec(repoId, ticketId))!;
    await app.recordAiOutput(repoId, ticketId, spec.currentStageId, 'Generated artifact', undefined, undefined, runId);
  });
  await service.start();
  await app.createSpec(id, 'RUN-1', 'Feature', { autoRun: true });
  await wait(async () => (await app.getSpec(id, 'RUN-1'))?.automation?.status === 'waiting_review');
  const pending = (await app.getSpec(id, 'RUN-1'))!;
  for (let i = 0; i < 5; i++) app.events.emit({ type: 'spec.updated', repoId: id, spec: pending });
  await new Promise((resolve) => setTimeout(resolve, 50)); expect(runs).toBe(1);
  await app.approve(id, 'RUN-1', 'spec', 1);
  await wait(async () => (await app.getSpec(id, 'RUN-1'))?.stages[1].gate.status === 'pending_review');
  expect(runs).toBe(2); await service.stop();
});
it('reconciles saved ready work on restart and keeps failed launches retryable', async () => {
  await app.createSpec(id, 'RUN-2', 'Feature', { autoRun: true });
  let runs = 0; const service = new Orchestrator(app, async () => { runs++; throw new Error('Codex unavailable'); });
  await service.start();
  await wait(async () => (await app.getSpec(id, 'RUN-2'))?.automation?.status === 'failed');
  expect(runs).toBe(1); expect((await app.getSpec(id, 'RUN-2'))?.automation?.error).toContain('unavailable');
  await service.stop();
  const restarted = new Orchestrator(app, async () => { runs++; }); await restarted.start();
  await new Promise((resolve) => setTimeout(resolve, 30)); expect(runs).toBe(1); await restarted.stop();
});
it('pause fences an in-flight result and prevents scheduling new work', async () => {
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  const service = new Orchestrator(app, async (repoId, ticketId, runId) => { await blocked; await app.recordAiOutput(repoId, ticketId, 'spec', 'Late output', undefined, undefined, runId); });
  await service.start(); await app.createSpec(id, 'RUN-3', 'Feature', { autoRun: true });
  await wait(async () => (await app.getSpec(id, 'RUN-3'))?.automation?.status === 'running');
  await app.pauseExecution(id, 'RUN-3'); release(); await service.stop();
  const spec = (await app.getSpec(id, 'RUN-3'))!; expect(spec.stages[0].artifact).toBeUndefined(); expect(spec.execution.status).toBe('paused');
});
it('a stale waiting snapshot cannot overwrite another live controller lease', async () => {
  await app.createSpec(id, 'RACE-1', 'Feature', { autoRun: true });
  await app.updateAutomation(id, 'RACE-1', (spec) => { spec.stages[0].gate.status = 'pending_review'; });
  const read = app.getExecutionStatus.bind(app); let interleaved = false;
  vi.spyOn(app, 'getExecutionStatus').mockImplementation(async (repoId, ticketId) => {
    const result = await read(repoId, ticketId);
    if (!interleaved) { interleaved = true; await app.updateAutomation(repoId, ticketId, (spec) => { Object.assign(spec.automation!, { status: 'running', runId: 'other-controller', ownerPid: process.pid }); }); }
    return result;
  });
  const service = new Orchestrator(app, async () => { throw new Error('Duplicate run'); });
  await service.start(); await wait(async () => interleaved);
  await new Promise((resolve) => setTimeout(resolve, 30)); await service.stop();
  const state = (await app.getSpec(id, 'RACE-1'))!.automation!;
  expect(state.status).toBe('running'); expect(state.runId).toBe('other-controller');
});
