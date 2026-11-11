import { beforeEach, afterEach, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppCore } from './app-core.js';
import { prepareStage, prepareImplementation, recordTaskLog } from '../test-support/workflow-fixtures.js';

let app: AppCore, repo: string, repoId: string;
beforeEach(async () => {
  repo = await fs.mkdtemp(join(tmpdir(), 'implementation-review-'));
  process.env.AI_PILOT_HOME = join(repo, '.specflow', 'registry');
  app = new AppCore(); repoId = (await app.addRepo(repo)).id;
  await app.createSpec(repoId, 'REV-1', 'Review implementation');
  await prepareStage(app, repo, repoId, 'REV-1', 'develop');
  await app.setDevelopSubtasks(repoId, 'REV-1', [{ id: 'A', description: 'Implement API' }]);
  await prepareImplementation(app, repoId, 'REV-1');
  await recordTaskLog(app, repoId, 'REV-1', 'A');
  await app.setSubtaskCompleted(repoId, 'REV-1', 'A', true);
});
afterEach(async () => { delete process.env.AI_PILOT_HOME; await fs.rm(repo, { recursive: true, force: true }); });

it('completed implementation cannot enter TEST without human review', async () => {
  await expect(app.advance(repoId, 'REV-1', 'develop')).rejects.toThrow(/implementation.*review|review.*implementation/i);
  expect((await app.getExecutionStatus(repoId, 'REV-1')).actions[0].tool).toBe('submit_implementation_review');
});
it('binds human review to its immutable report and source fingerprint', async () => {
  const submitted = await app.submitImplementationReview(repoId, 'REV-1');
  const review = submitted.stages[3].subtasks![0].review!;
  expect(review.status).toBe('pending_review');
  const report = await app.getImplementationReview(repoId, 'REV-1', 'A');
  expect(report.content).toContain('Fixture implementation');
  await expect(app.reviewImplementation(repoId, 'REV-1', 'A', 'wrong', 'approved')).rejects.toThrow(/changed|review/i);
  await app.reviewImplementation(repoId, 'REV-1', 'A', review.id, 'approved');
  await fs.writeFile(join(repo, 'changed.ts'), 'changed after review');
  await expect(app.advance(repoId, 'REV-1', 'develop')).rejects.toThrow(/source|changed/i);
});
it('approve permits advancement and repeated completion preserves the review', async () => {
  const submitted = await app.submitImplementationReview(repoId, 'REV-1');
  const review = submitted.stages[3].subtasks![0].review!;
  await app.reviewImplementation(repoId, 'REV-1', 'A', review.id, 'approved');
  await app.setSubtaskCompleted(repoId, 'REV-1', 'A', true);
  expect((await app.advance(repoId, 'REV-1', 'develop')).currentStageId).toBe('test');
});
it('revision resets implementation, preserves review history, and invalidates old approval', async () => {
  const submitted = await app.submitImplementationReview(repoId, 'REV-1');
  const review = submitted.stages[3].subtasks![0].review!;
  const revised = await app.reviewImplementation(repoId, 'REV-1', 'A', review.id, 'needs_revision', 'Fix validation');
  expect(revised.stages[3].subtasks![0].completed).toBe(false);
  expect(revised.stages[3].subtasks![0].attempt).toBe(1);
  expect(revised.stages[3].subtasks![0].reviewHistory![0].comment).toBe('Fix validation');
  await expect(app.reviewImplementation(repoId, 'REV-1', 'A', review.id, 'approved')).rejects.toThrow(/review/i);
});
