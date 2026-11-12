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
  await app.setDevelopSubtasks(repoId, 'REV-1', [{ id: 'A', title: 'API implementation', description: 'Implement API' }]);
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
  expect(submitted.stages[3].subtasks![0].title).toBe('API implementation');
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

async function submitTwoReports() {
  await app.setDevelopSubtasks(repoId, 'REV-1', [{ id: 'A', title: 'API implementation', description: 'Implement API' }, { id: 'B', description: 'Implement tests', dependsOn: ['A'] }]);
  await prepareImplementation(app, repoId, 'REV-1');
  for (const id of ['A', 'B']) {
    await recordTaskLog(app, repoId, 'REV-1', id);
    await app.setSubtaskCompleted(repoId, 'REV-1', id, true);
  }
  const submitted = await app.submitImplementationReview(repoId, 'REV-1');
  return submitted.stages[3].subtasks!.map(task => ({ subtaskId: task.id, expectedReviewId: task.review!.id }));
}

it('reads all reports and approves the exact pending set in one update', async () => {
  const reviews = await submitTwoReports();
  const reports = await app.getImplementationReviews(repoId, 'REV-1');
  expect(reports.map(report => report.subtaskId)).toEqual(['A', 'B']);
  expect(reports.every(report => report.content.includes('Fixture implementation') && !report.sourceChanged)).toBe(true);
  const events: string[] = [];
  const unsubscribe = app.events.subscribe(event => events.push(event.type));
  const approved = await app.reviewImplementationBatch(repoId, 'REV-1', reviews, 'approved');
  unsubscribe();
  expect(events).toEqual(['spec.updated']);
  expect(approved.stages[3].subtasks!.every(task => task.review?.status === 'approved')).toBe(true);
  expect((await app.advance(repoId, 'REV-1', 'develop')).currentStageId).toBe('test');
});

it.each(['stale report', 'changed source', 'missing task', 'duplicate task'])('rejects the whole approval batch for %s', async kind => {
  const reviews = await submitTwoReports();
  if (kind === 'stale report') reviews[1].expectedReviewId = 'outdated';
  if (kind === 'changed source') await fs.writeFile(join(repo, 'changed.ts'), 'changed after reports');
  if (kind === 'missing task') reviews.pop();
  if (kind === 'duplicate task') reviews[1] = reviews[0];
  await expect(app.reviewImplementationBatch(repoId, 'REV-1', reviews, 'approved')).rejects.toThrow(/changed|pending|report/i);
  expect((await app.getSpec(repoId, 'REV-1'))!.stages[3].subtasks!.map(task => task.review!.status)).toEqual(['pending_review', 'pending_review']);
});

it('does not overwrite an individual decision made while all reports were open', async () => {
  const reviews = await submitTwoReports();
  await app.reviewImplementation(repoId, 'REV-1', 'A', reviews[0].expectedReviewId, 'approved');
  await expect(app.reviewImplementationBatch(repoId, 'REV-1', reviews, 'approved')).rejects.toThrow(/changed|pending|report/i);
  expect((await app.getSpec(repoId, 'REV-1'))!.stages[3].subtasks![1].review!.status).toBe('pending_review');
  await app.reviewImplementationBatch(repoId, 'REV-1', [reviews[1]], 'approved');
  await expect(app.reviewImplementationBatch(repoId, 'REV-1', [], 'approved')).rejects.toThrow(/pending|report/i);
});


it.each(['needs_revision', 'rejected'] as const)('applies bulk %s with one comment and resets dependent tasks only once', async verdict => {
  const reviews = await submitTwoReports();
  await expect(app.reviewImplementationBatch(repoId, 'REV-1', reviews, verdict, '  ')).rejects.toThrow(/comment/i);
  const before = (await app.getSpec(repoId, 'REV-1'))!.stages[3].subtasks!;
  expect(before.every(task => task.review?.status === 'pending_review')).toBe(true);
  const revised = await app.reviewImplementationBatch(repoId, 'REV-1', reviews, verdict, ' Fix validation ');
  for (const task of revised.stages[3].subtasks!) {
    expect(task.completed).toBe(false);
    expect(task.attempt).toBe(before.find(prior => prior.id === task.id)!.attempt + 1);
    expect(task.review).toBeUndefined();
    expect(task.reviewHistory!.at(-1)).toMatchObject({ status: verdict, comment: 'Fix validation' });
  }
  expect(revised.currentStageId).toBe('develop');
  await expect(app.advance(repoId, 'REV-1', 'develop')).rejects.toThrow();
});
