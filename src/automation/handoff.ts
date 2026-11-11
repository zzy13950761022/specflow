import type { AppCore } from '../core/app-core.js';
import type { SpecFile } from '../core/schemas.js';
import { processGroupAlive } from '../core/processes.js';

function ownerAlive(spec: SpecFile): boolean {
  if (!spec.automation?.ownerPid) return false;
  try { process.kill(spec.automation.ownerPid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function checkActive(spec: SpecFile) {
  if (spec.stages.some(stage => stage.activeCheck)) throw new Error('A platform check is active. Wait for it to finish before handing off.');
}
export async function getHandoff(app: AppCore, repoId: string, ticketId: string) {
  const repo = await app.registry.resolve(repoId);
  const spec = await app.getSpec(repoId, ticketId);
  if (!repo || !spec) throw new Error('Unknown repository or ticket.');
  const workspacePath = spec.automation?.worktreePath ?? repo.path;
  const mode = spec.automation?.enabled || spec.automation?.mode === 'dashboard' ? 'dashboard' as const : 'ide' as const;
  const reason = spec.stages.some(stage => stage.activeCheck) ? 'Wait for the active platform check to finish.' : undefined;
  const context = [
    '/specflow ' + ticketId, '',
    'Repository: ' + repo.name, 'Repository ID: ' + repoId, 'Repository path: ' + repo.path,
    'Working directory: ' + workspacePath, '',
    'Continue this existing ticket through AI Pilot MCP; do not create another ticket.',
    'Resolve the canonical Repository ID above even when the working directory is a ticket worktree.',
    'Read the latest workflow state, review decisions, task claims and next actions before changing files.',
    'Use the working directory for source edits; use AI Pilot tools for canonical workflow state.',
    'If Dashboard automation is enabled, use Continue in IDE in Dashboard before making changes.',
    'Existing approval must be read from the platform. Do not infer approval from this context.',
  ].join('\n');
  return { context, workspacePath, mode, canHandoff: !reason, reason };
}
export async function handoffToIde(app: AppCore, repoId: string, ticketId: string) {
  const initial = await app.getSpec(repoId, ticketId);
  if (!initial) throw new Error('Unknown ticket.');
  checkActive(initial);
  if (!initial.automation?.enabled && initial.automation?.mode !== 'dashboard') return getHandoff(app, repoId, ticketId);
  await app.updateAutomation(repoId, ticketId, spec => {
    checkActive(spec);
    if (spec.execution.status !== 'completed') spec.execution.status = 'paused';
    if (spec.automation) { spec.automation.enabled = false; spec.automation.runId = undefined; spec.automation.status = 'paused'; }
  });
  const deadline = Date.now() + 15_000;
  for (;;) {
    const spec = (await app.getSpec(repoId, ticketId))!;
    if (!ownerAlive(spec) && !processGroupAlive(spec.automation?.runnerPid)) break;
    if (Date.now() >= deadline) throw new Error('Agent is still stopping. Keep the IDE idle and retry handoff once the process exits.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await app.updateAutomation(repoId, ticketId, spec => {
    checkActive(spec);
    if (ownerAlive(spec) || processGroupAlive(spec.automation?.runnerPid)) throw new Error('Agent is still stopping.');
    if (spec.automation) { spec.automation.mode = 'ide'; spec.automation.enabled = false; spec.automation.ownerPid = undefined; spec.automation.runnerPid = undefined; }
    if (initial.execution.status !== 'completed') { spec.execution.status = 'ready'; spec.execution.error = undefined; }
    else spec.execution.status = 'completed';
  });
  return getHandoff(app, repoId, ticketId);
}
export async function resumeAutomation(app: AppCore, repoId: string, ticketId: string, profileId?: string) {
  const spec = await app.getSpec(repoId, ticketId);
  if (!spec) throw new Error('Unknown ticket.');
  checkActive(spec);
  if (spec.stages.some(stage => stage.subtasks?.some(task => task.status === 'running'))) throw new Error('Finish or release active IDE task claims before resuming Dashboard.');
  if (ownerAlive(spec) || processGroupAlive(spec.automation?.runnerPid)) throw new Error('Previous Agent is still running.');
  if (spec.execution.status === 'completed') throw new Error('This workflow is already completed.');
  const profile = profileId ? await app.agentSettings.resolve(profileId) : spec.automation?.profile ?? await app.agentSettings.resolve();
  // Keep automation disabled during recovery; enabling is the final operation.
  if (spec.automation?.enabled) await app.configureAutomation(repoId, ticketId, false);
  await app.resumeExecution(repoId, ticketId);
  return app.configureAutomation(repoId, ticketId, true, profile);
}
