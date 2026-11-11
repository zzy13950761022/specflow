import { beforeEach, afterEach, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppCore } from './app-core.js';
import type { WorkflowOptions } from './schemas.js';

let repo: string; let home: string; let app: AppCore; let repoId: string;
beforeEach(async () => {
  repo = await fs.mkdtemp(join(tmpdir(), 'integration-repo-')); home = await fs.mkdtemp(join(tmpdir(), 'integration-home-'));
  process.env.AI_PILOT_HOME = home; app = new AppCore(); repoId = (await app.addRepo(repo)).id;
  await fs.writeFile(join(repo, 'source.ts'), 'initial'); await fs.mkdir(join(repo, '.specflow'));
  await fs.writeFile(join(repo, '.specflow/checks.json'), JSON.stringify({
    test: { command: process.execPath, args: ['-e', 'const fs=require("fs");fs.mkdirSync("coverage",{recursive:true});fs.writeFileSync("coverage/coverage-summary.json",JSON.stringify({total:{lines:{pct:90,total:100,covered:90}}}))'], coverageReport: 'coverage/coverage-summary.json' },
    build: { command: process.execPath, args: ['-e', 'console.log("built")'] },
  }));
});
afterEach(async () => { delete process.env.AI_PILOT_HOME; await fs.rm(repo, { recursive: true, force: true }); await fs.rm(home, { recursive: true, force: true }); });

async function enterTest(options: WorkflowOptions = {}) {
  const spec = await app.createSpec(repoId, 'INT-1', 'Feature', options);
  for (const stage of spec.stages.slice(0, 4)) {
    if (stage.skipped) continue;
    if (stage.id === 'develop') await app.setDevelopSubtasks(repoId, 'INT-1', [{ id: 'A', description: 'Implement', files: ['source.ts'] }]);
    await app.recordAiOutput(repoId, 'INT-1', stage.id, 'Approved ' + stage.id);
    await app.approve(repoId, 'INT-1', stage.id);
    if (stage.id === 'develop') {
      await app.logImplementation(repoId, 'INT-1', 'A', { summary: 'Implemented', filesModified: ['source.ts'], filesCreated: [], statistics: { linesAdded: 1, linesRemoved: 0 }, artifacts: {} });
      await app.setSubtaskCompleted(repoId, 'INT-1', 'A', true);
      const reviewed = await app.submitImplementationReview(repoId, 'INT-1');
      await app.reviewImplementation(repoId, 'INT-1', 'A', reviewed.stages[3].subtasks![0].review!.id, 'approved');
    }
    await app.advance(repoId, 'INT-1', stage.id);
  }
}

it('real evidence supports opted-in policy approval and records the policy actor', async () => {
  await enterTest({ risk: 'low', autoChecks: true });
  await app.runStageCheck(repoId, 'INT-1', 'test');
  const spec = await app.recordAiOutput(repoId, 'INT-1', 'test', 'Actual test results');
  expect(spec.stages[4].gate.status).toBe('approved');
  expect(spec.gateHistory.at(-1)!.actor).toBe('policy');
  expect(spec.gateHistory.at(-1)!.comment).toContain('policy');
});

it('source drift after TEST blocks BUILD and requires revalidation', async () => {
  await enterTest(); await app.runStageCheck(repoId, 'INT-1', 'test');
  await app.recordAiOutput(repoId, 'INT-1', 'test', 'Results'); await app.approve(repoId, 'INT-1', 'test'); await app.advance(repoId, 'INT-1', 'test');
  await fs.writeFile(join(repo, 'source.ts'), 'changed after test');
  await expect(app.runStageCheck(repoId, 'INT-1', 'build')).rejects.toThrow(/source changed/i);
  await expect(app.getStageContext(repoId, 'INT-1', 'build')).rejects.toThrow(/source changed/i);
  const status = await app.getExecutionStatus(repoId, 'INT-1');
  expect(status.actions[0].tool).toBe('reopen_stage');
  expect(status.actions[0].stageId).toBe('develop');
});

it('rework retains structured requirements history', async () => {
  await app.createSpec(repoId, 'INT-1', 'Feature'); await app.recordAiOutput(repoId, 'INT-1', 'spec', 'Spec');
  await app.approve(repoId, 'INT-1', 'spec'); await app.advance(repoId, 'INT-1', 'spec');
  const data = { affectedFiles: [{ path: 'old.ts' }], reuse: [], buildFromScratch: [], dataMigration: [], integrations: [] };
  await app.recordAiOutput(repoId, 'INT-1', 'requirements', 'Old requirements', { kind: 'requirements', data });
  await app.reopenStage(repoId, 'INT-1', 'requirements', 'Change scope');
  const next = await app.recordAiOutput(repoId, 'INT-1', 'requirements', 'New requirements', { kind: 'requirements', data: { ...data, affectedFiles: [{ path: 'new.ts' }] } });
  const old = next.stages[1].artifactHistory![0].artifact;
  expect(old?.kind).toBe('requirements');
  if (old?.kind === 'requirements') expect(JSON.parse(await fs.readFile(join(repo, old.dataPath), 'utf8')).affectedFiles[0].path).toBe('old.ts');
});

it('approval wait wakes on a decision and cancellation cleans up', async () => {
  await app.createSpec(repoId, 'INT-1', 'Feature'); await app.recordAiOutput(repoId, 'INT-1', 'spec', 'Spec');
  const controller = new AbortController();
  const waiting = app.waitForApproval(repoId, 'INT-1', 'spec', 1000, controller.signal);
  controller.abort();
  await expect(waiting).rejects.toThrow(/cancelled/i);
  const decision = app.waitForApproval(repoId, 'INT-1', 'spec', 1000);
  await app.approve(repoId, 'INT-1', 'spec');
  expect((await decision).status).toBe('approved');
});

it('reject and revise cannot act on an outdated reviewed revision', async () => {
  await app.createSpec(repoId, 'INT-1', 'Feature'); await app.recordAiOutput(repoId, 'INT-1', 'spec', 'Spec');
  await expect(app.reject(repoId, 'INT-1', 'spec', 'Old review', 0)).rejects.toThrow(/revision/i);
  await expect(app.requestRevision(repoId, 'INT-1', 'spec', 'Old review', 0)).rejects.toThrow(/revision/i);
});

it('rework cannot detach a live check and allow overlapping commands', async () => {
  await fs.writeFile(join(repo, '.specflow/checks.json'), JSON.stringify({ test: { command: process.execPath, args: ['-e', 'setTimeout(()=>{},150)'] } }));
  await enterTest(); await app.recordAiOutput(repoId, 'INT-1', 'test', 'Tests planned');
  const running = app.runStageCheck(repoId, 'INT-1', 'test');
  while (!(await app.getSpec(repoId, 'INT-1'))!.stages[4].activeCheck) await new Promise((resolve) => setTimeout(resolve, 1));
  await expect(app.reopenStage(repoId, 'INT-1', 'test', 'Change plan')).rejects.toThrow(/running.*check|check.*running/i);
  await running;
});

it('completed workflows retain no next actions after later source changes', async () => {
  await enterTest();
  for (const stageId of ['test', 'build', 'deploy', 'ops'] as const) {
    if (stageId === 'test' || stageId === 'build') await app.runStageCheck(repoId, 'INT-1', stageId);
    await app.recordAiOutput(repoId, 'INT-1', stageId, 'Completed ' + stageId);
    await app.approve(repoId, 'INT-1', stageId);
    if (stageId !== 'ops') await app.advance(repoId, 'INT-1', stageId);
  }
  await fs.writeFile(join(repo, 'source.ts'), 'later unrelated work');
  expect(await app.getExecutionStatus(repoId, 'INT-1')).toMatchObject({ status: 'completed', actions: [] });
});

it('submissions cannot change the revision while a check is running', async () => {
  await fs.writeFile(join(repo, '.specflow/checks.json'), JSON.stringify({ test: { command: process.execPath, args: ['-e', 'setTimeout(()=>{},150)'] } }));
  await enterTest();
  const running = app.runStageCheck(repoId, 'INT-1', 'test');
  while (!(await app.getSpec(repoId, 'INT-1'))!.stages[4].activeCheck) await new Promise((resolve) => setTimeout(resolve, 1));
  await expect(app.recordAiOutput(repoId, 'INT-1', 'test', 'Changed plan')).rejects.toThrow(/check.*running|running.*check/i);
  await running;
});

it('invalid acceptance criteria leave artifact files untouched', async () => {
  await app.createSpec(repoId, 'INT-1', 'Feature');
  await expect(app.recordAiOutput(repoId, 'INT-1', 'spec', 'Invalid spec', undefined, [{ id: 'A', given: '', when: 'run', then: 'pass' }])).rejects.toThrow();
  expect(await app.readArtifact(repoId, 'INT-1', 'spec')).toBeNull();
  expect(await fs.stat(join(repo, '.specflow/specs/INT-1-feature.md')).then(() => true, () => false)).toBe(false);
});

it('SPEC revision does not create outdated DEVELOP versions while drafting tasks', async () => {
  await app.createSpec(repoId, 'INT-1', 'Bug fix', { workflowKind: 'bugfix' });
  await app.recordAiOutput(repoId, 'INT-1', 'spec', 'Initial spec');
  await app.requestRevision(repoId, 'INT-1', 'spec', 'Adjust scope', 1);
  await app.recordAiOutput(repoId, 'INT-1', 'spec', 'Revised spec');
  await app.approve(repoId, 'INT-1', 'spec', 2);
  await app.advance(repoId, 'INT-1', 'spec');
  for (const description of ['Initial task draft', 'Final task draft']) {
    const draft = await app.setDevelopSubtasks(repoId, 'INT-1', [{ id: 'A', description }]);
    expect(draft.stages[3]).toMatchObject({ revision: 0, stale: false, gate: { status: 'not_ready' } });
    expect(draft.stages[3].artifact).toBeUndefined();
    await expect(app.approve(repoId, 'INT-1', 'develop', 0)).rejects.toThrow(/pending_review/i);
  }
  const submitted = await app.recordAiOutput(repoId, 'INT-1', 'develop', 'Final implementation plan');
  expect(submitted.stages[3]).toMatchObject({ revision: 1, stale: false, gate: { status: 'pending_review' } });
  expect(submitted.stages[3].artifactHistory).toHaveLength(1);
  expect((await app.getArtifactReview(repoId, 'INT-1', 'develop')).revision).toBe(1);
  await app.approve(repoId, 'INT-1', 'develop', 1);
  expect((await app.getSpec(repoId, 'INT-1'))!.stages[0].gate.approvedRevision).toBe(2);
});

it('changing tasks after plan submission still invalidates its review and approval', async () => {
  await app.createSpec(repoId, 'INT-1', 'Docs', { workflowKind: 'documentation' });
  await app.recordAiOutput(repoId, 'INT-1', 'spec', 'Spec');
  await app.approve(repoId, 'INT-1', 'spec');
  await app.advance(repoId, 'INT-1', 'spec');
  await app.setDevelopSubtasks(repoId, 'INT-1', [{ id: 'A', description: 'Initial task' }]);
  const submitted = await app.recordAiOutput(repoId, 'INT-1', 'develop', 'Initial plan');
  const oldRevision = submitted.stages[3].revision;
  const changed = await app.setDevelopSubtasks(repoId, 'INT-1', [{ id: 'B', description: 'Changed task' }]);
  expect(changed.stages[3].revision).toBeGreaterThan(oldRevision);
  expect(changed.stages[3].stale).toBe(true);
  await expect(app.approve(repoId, 'INT-1', 'develop', oldRevision)).rejects.toThrow();
  const updated = await app.recordAiOutput(repoId, 'INT-1', 'develop', 'Updated plan');
  await app.approve(repoId, 'INT-1', 'develop', updated.stages[3].revision);
  const invalidated = await app.setDevelopSubtasks(repoId, 'INT-1', [{ id: 'C', description: 'Later task' }]);
  expect(invalidated.stages[3]).toMatchObject({ stale: true, gate: { status: 'not_ready' } });
  expect(invalidated.stages[3].gate.approvedRevision).toBeUndefined();
  await expect(app.claimSubtask(repoId, 'INT-1', 'C')).rejects.toThrow(/approved/i);
});

it('excludes configured Maven outputs at approval but invalidates a changed output policy at advance', async () => {
  const path = join(repo, '.specflow/checks.json');
  const config = JSON.parse(await fs.readFile(path, 'utf8'));
  config.generatedPaths = ['srv/target'];
  await fs.writeFile(path, JSON.stringify(config));
  await enterTest();
  await app.runStageCheck(repoId, 'INT-1', 'test');
  await app.recordAiOutput(repoId, 'INT-1', 'test', 'Results');
  await fs.mkdir(join(repo, 'srv/target'), { recursive: true });
  await fs.writeFile(join(repo, 'srv/target/build-output'), 'generated');
  await app.approve(repoId, 'INT-1', 'test');
  config.generatedPaths.push('srv/src/gen');
  await fs.writeFile(path, JSON.stringify(config));
  await expect(app.advance(repoId, 'INT-1', 'test')).rejects.toThrow(/changed/i);
});
