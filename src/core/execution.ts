import type { SpecFile } from './schemas.js';
import { readyTasks } from './task-scheduler.js';
import { assertEvidence } from './check-runner.js';

export type NextAction = { tool: string; stageId: SpecFile['currentStageId']; subtaskId?: string; reason: string };
export function completionAction(subtaskId: string, claimId?: string) {
  return { tool: 'set_subtask_completed', stageId: 'develop' as const, subtaskId, completed: true, claimId,
    reason: 'Implementation logged. Set this task completed using its current claimId when claimed.' };
}
export function nextActions(spec: SpecFile): NextAction[] {
  if (spec.execution.status === 'paused') return [];
  const stage = spec.stages.find((stage) => stage.id === spec.currentStageId)!;
  const action = (tool: string, reason: string): NextAction => ({ tool, stageId: stage.id, reason });
  if (stage.activeCheck) return [];
  if (stage.gate.status === 'pending_review') {
    if (stage.id === 'test' || stage.id === 'build') {
      try { assertEvidence(stage.evidence, stage.id); } catch { return [action('run_stage_check', 'A passing platform check with actual evidence is required before review.')]; }
    }
    return [action('get_approval_status', 'Wait for human review of revision ' + stage.revision + '.')];
  }
  if (stage.gate.status === 'approved') {
    if (stage.id === 'ops') return [];
    if (stage.id === 'develop' && stage.subtasks?.some((task) => !task.completed)) {
      const running = stage.subtasks.filter((task) => task.status === 'running');
      return [
        ...running.map((task) => ({ ...action('log_implementation', 'Implement the claimed task, record its log, then set_subtask_completed using the claimId.'), subtaskId: task.id })),
        ...readyTasks(stage.subtasks).map((task) => ({ ...action('claim_subtask', 'Dependencies are complete and declared files do not conflict.'), subtaskId: task.id })),
      ];
    }
    if (stage.id === 'develop' && !stage.subtasks?.length) return [action('set_develop_subtasks', 'Register and resubmit a non-empty implementation plan.')];
    if (stage.id === 'develop' && stage.subtasks?.some((task) => task.review?.status !== 'approved')) {
      return [action(stage.subtasks.some((task) => !task.review) ? 'submit_implementation_review' : 'get_implementation_review', 'Human review of completed implementation is required before TEST.')];
    }
    return [action('advance_stage', 'Current revision is approved and execution is complete.')];
  }
  if (stage.id === 'develop' && !stage.subtasks?.length) return [action('set_develop_subtasks', 'Register the implementation plan, then submit its summary for approval.')];
  return [action('get_stage_prompt', (stage.gate.comment ? 'Address review: ' + stage.gate.comment + '. ' : '') + 'Generate the current stage artifact and submit it with record_ai_output.')];
}

export function synchronizeExecution(spec: SpecFile): SpecFile {
  if (spec.execution.status === 'paused') return spec;
  const stage = spec.stages.find((stage) => stage.id === spec.currentStageId)!;
  if (stage.activeCheck || stage.subtasks?.some((task) => task.status === 'running')) spec.execution.status = 'running';
  else if (spec.execution.error) spec.execution.status = 'failed';
  else if (stage.id === 'ops' && stage.gate.status === 'approved') spec.execution.status = 'completed';
  else if (stage.gate.status === 'pending_review' || stage.subtasks?.some((task) => task.review?.status === 'pending_review')) spec.execution.status = 'waiting_review';
  else spec.execution.status = 'ready';
  return spec;
}
