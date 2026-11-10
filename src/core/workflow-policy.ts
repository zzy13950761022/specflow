import type { StageId, SpecFile } from './schemas.js';

export const WORKFLOW_STAGES: Record<SpecFile['workflow']['workflowKind'], readonly StageId[]> = {
  standard: ['spec', 'requirements', 'design', 'develop', 'test', 'build', 'deploy', 'ops'],
  bugfix: ['spec', 'develop', 'test', 'build', 'deploy', 'ops'],
  documentation: ['spec', 'develop', 'ops'],
};

export function canAutoApprove(spec: SpecFile, stageId: StageId): boolean {
  return spec.workflow.autoChecks && spec.workflow.risk === 'low' && (stageId === 'test' || stageId === 'build');
}
