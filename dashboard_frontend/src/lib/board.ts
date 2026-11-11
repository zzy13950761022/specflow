import type { SpecFile } from '../types';
import { currentStageId } from './stage';

export interface BoardFilters { query: string; status: string; stage: string; workflow: string; sort: string }
export function boardStatus(spec: SpecFile): SpecFile['execution']['status'] {
  const executionStatus = spec.execution.status;
  if (executionStatus === 'paused' || executionStatus === 'completed') return executionStatus;
  if (spec.automation?.enabled) {
    const status = spec.automation.status;
    if (status === 'running' || status === 'failed' || status === 'waiting_review') return status;
    if (status === 'queued') return 'ready';
  }
  return executionStatus;
}
export function readBoardFilters(params: URLSearchParams): BoardFilters {
  return { query: params.get('q') ?? '', status: params.get('status') ?? '', stage: params.get('filterStage') ?? '', workflow: params.get('workflow') ?? '', sort: params.get('sort') ?? 'updated' };
}
export function writeBoardFilters(filters: BoardFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ q: filters.query, status: filters.status, filterStage: filters.stage, workflow: filters.workflow, sort: filters.sort === 'updated' ? '' : filters.sort })) if (value) params.set(key, value);
  return params;
}
export function filterSpecs(specs: SpecFile[], filters: BoardFilters): SpecFile[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return specs.filter((spec) => (!query || (spec.ticketId + ' ' + spec.title).toLocaleLowerCase().includes(query))
    && (!filters.status || boardStatus(spec) === filters.status)
    && (!filters.stage || currentStageId(spec) === filters.stage)
    && (!filters.workflow || spec.workflow.workflowKind === filters.workflow))
    .sort((a, b) => filters.sort === 'ticket' ? a.ticketId.localeCompare(b.ticketId, undefined, { numeric: true })
      : (filters.sort === 'created' ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt)) || a.ticketId.localeCompare(b.ticketId));
}
