import { randomUUID } from 'crypto';
import type { AppCore } from '../core/app-core.js';
import type { SpecFile } from '../core/schemas.js';
import { logger } from '../core/logger.js';
import { processGroupAlive } from '../core/processes.js';

export type ExecuteTurn = (repoId: string, ticketId: string, runId: string, signal: AbortSignal) => Promise<void>;
export function processAlive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function progress(spec: SpecFile): string {
  return JSON.stringify([spec.currentStageId, spec.stages.map((stage) => [stage.revision, stage.gate.status, stage.evidence?.runId, stage.subtasks?.map((task) => [task.status, task.attempt, task.review?.id])])]);
}
function sameSnapshot(current: SpecFile, expected: SpecFile): boolean {
  return current.stateVersion === expected.stateVersion && current.automation?.runId === expected.automation?.runId;
}

/** Persisted ticket state is the queue. Events only request reconciliation. */
export class Orchestrator {
  private queued = new Map<string, [string, string]>();
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private unsubscribe?: () => void;
  private stopped = true;
  constructor(private app: AppCore, private execute: ExecuteTurn, private concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer.');
  }
  async start(): Promise<void> {
    this.stopped = false;
    this.unsubscribe = this.app.events.subscribe((event) => {
      if (event.type !== 'spec.created' && event.type !== 'spec.updated') return;
      const key = event.repoId + ':' + event.spec.ticketId;
      if (event.spec.execution.status === 'paused' || !event.spec.automation?.enabled) this.active.get(key)?.controller.abort();
      this.enqueue(event.repoId, event.spec.ticketId);
    });
    for (const repo of await this.app.listRepos()) for (const spec of await this.app.listSpecs(repo.id)) this.enqueue(repo.id, spec.ticketId);
  }
  private enqueue(repoId: string, ticketId: string): void {
    if (this.stopped) return;
    const key = repoId + ':' + ticketId;
    this.queued.set(key, [repoId, ticketId]); this.drain();
  }
  private drain(): void {
    if (this.stopped) return;
    for (const [key, [repoId, ticketId]] of this.queued) {
      if (this.active.has(key)) continue;
      if (this.active.size >= this.concurrency) break;
      this.queued.delete(key);
      const controller = new AbortController();
      // Defer to ensure the active map is populated before events fire.
      const promise = Promise.resolve().then(() => this.reconcile(repoId, ticketId, controller.signal)).catch((error) => logger.warn('Automation reconciliation failed', repoId, ticketId, String(error))).finally(() => { this.active.delete(key); this.drain(); });
      this.active.set(key, { controller, promise });
    }
  }
  private async reconcile(repoId: string, ticketId: string, signal: AbortSignal): Promise<void> {
    while (!this.stopped && !signal.aborted) {
      const spec = await this.app.getSpec(repoId, ticketId);
      if (!spec?.automation?.enabled || spec.automation.status === 'failed') return;
      if (spec.execution.status === 'paused' || spec.execution.status === 'completed') {
        const status = spec.execution.status;
        if (spec.automation.status !== status) await this.app.updateAutomation(repoId, ticketId, (current) => { if (current.automation && sameSnapshot(current, spec)) current.automation.status = status; });
        return;
      }
      if (spec.automation.status === 'running' || spec.automation.runId || processGroupAlive(spec.automation.runnerPid)) {
        if (processAlive(spec.automation.ownerPid)) return;
        await this.app.updateAutomation(repoId, ticketId, (current) => {
          if (!current.automation || !sameSnapshot(current, spec)) return;
          current.automation.status = 'failed'; current.automation.error = processGroupAlive(current.automation.runnerPid) ? 'Previous runner is still alive. Stop it before retrying.' : 'Previous run was interrupted. Review its work and retry explicitly.';
        });
        return;
      }
      const execution = await this.app.getExecutionStatus(repoId, ticketId);
      let action = execution.actions[0];
      const stage = spec.stages.find((stage) => stage.id === spec.currentStageId)!;
      if ((stage.id === 'test' || stage.id === 'build') && !stage.activeCheck && !stage.evidence && stage.gate.status !== 'approved' && execution.status !== 'failed') action = { tool: 'run_stage_check', stageId: stage.id, reason: 'Record actual platform evidence before generating a result report.' };
      if (execution.status === 'failed') {
        await this.app.updateAutomation(repoId, ticketId, (current) => { if (current.automation && sameSnapshot(current, spec)) { current.automation.status = 'failed'; current.automation.error = execution.error; } }); return;
      }
      if (!action || ['get_approval_status', 'get_implementation_review'].includes(action.tool)) {
        if (spec.automation.status !== 'waiting_review') await this.app.updateAutomation(repoId, ticketId, (current) => { if (current.automation && sameSnapshot(current, spec)) current.automation.status = 'waiting_review'; });
        return;
      }
      const runId = randomUUID(); let claimed = false;
      await this.app.updateAutomation(repoId, ticketId, (current) => {
        if (!sameSnapshot(current, spec) || !current.automation?.enabled || current.automation.status === 'running' || current.automation.status === 'failed' || current.automation.runId || processGroupAlive(current.automation.runnerPid) || current.execution.status === 'paused' || current.execution.status === 'completed') return;
        claimed = true; Object.assign(current.automation, { status: 'running', runId, ownerPid: process.pid, runnerPid: undefined, error: undefined, attempt: current.automation.attempt + 1, startedAt: new Date().toISOString() });
      });
      if (!claimed) return;
      try {
        if (signal.aborted) throw new Error('Automation stopped.');
        // Domain actions are deterministic and never delegated to the model.
        if (action.tool === 'advance_stage') await this.app.advance(repoId, ticketId, action.stageId, runId);
        else if (action.tool === 'reopen_stage') await this.app.reopenStage(repoId, ticketId, action.stageId, action.reason, runId);
        else if (action.tool === 'submit_implementation_review') await this.app.submitImplementationReview(repoId, ticketId);
        else if (action.tool === 'run_stage_check') await this.app.runStageCheck(repoId, ticketId, action.stageId as 'test' | 'build', runId);
        else await this.execute(repoId, ticketId, runId, signal);
        const after = await this.app.getSpec(repoId, ticketId);
        if (after && after.execution.status !== 'paused' && progress(after) === progress(spec)) throw new Error('Codex run made no workflow progress. Inspect the result and retry explicitly.');
        await this.app.updateAutomation(repoId, ticketId, (current) => {
          if (current.automation?.runId !== runId) return;
          current.automation.status = current.execution.status === 'completed' ? 'completed' : 'queued'; current.automation.runId = undefined; current.automation.runnerPid = undefined; current.automation.finishedAt = new Date().toISOString();
        });
      } catch (error) {
        await this.app.updateAutomation(repoId, ticketId, (current) => {
          if (current.automation?.runId !== runId) return;
          current.automation.status = 'failed'; current.automation.error = String((error as Error).message); current.automation.runId = undefined; if (!processGroupAlive(current.automation.runnerPid)) current.automation.runnerPid = undefined;
        });
        return;
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; this.unsubscribe?.(); this.queued.clear();
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled([...this.active.values()].map((task) => task.promise));
  }
}
