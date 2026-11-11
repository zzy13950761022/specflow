import { describe, expect, it } from 'vitest';
import { StageMachine } from '../../../src/core/stage-machine';
import { boardStatus, filterSpecs, readBoardFilters, writeBoardFilters } from './board';

const machine = new StageMachine();
const first = machine.createSpec({ ticketId: 'ABC-2', title: 'Repair checkout', workflowKind: 'bugfix' });
const second = machine.createSpec({ ticketId: 'ABC-10', title: 'Document billing', workflowKind: 'documentation' });
first.updatedAt = '2026-01-02'; second.updatedAt = '2026-01-03';
first.execution.status = 'paused';

describe('board filtering', () => {
  it('matches ticket or title without case and combines filters', () => {
    const filters = readBoardFilters(new URLSearchParams('q=CHECKOUT&status=paused&workflow=bugfix&filterStage=spec'));
    expect(filterSpecs([first, second], filters)).toEqual([first]);
    expect(filterSpecs([first, second], { ...filters, query: 'abc-10' })).toEqual([]);
  });
  it('sorts without changing shared live spec order', () => {
    const specs = [first, second];
    expect(filterSpecs(specs, readBoardFilters(new URLSearchParams()))).toEqual([second, first]);
    expect(filterSpecs(specs, readBoardFilters(new URLSearchParams('sort=ticket')))).toEqual([first, second]);
    expect(specs).toEqual([first, second]);
  });
  it('roundtrips URL filters separately from the detail selected stage', () => {
    const filters = readBoardFilters(new URLSearchParams('q=API&status=failed&filterStage=develop&workflow=bugfix&sort=created&stage=spec'));
    const result = writeBoardFilters(filters);
    expect(readBoardFilters(result)).toEqual(filters);
    expect(result.has('stage')).toBe(false);
  });
});


describe('managed spec board status', () => {
  it.each(['running', 'failed', 'waiting_review'] as const)('shows a ready spec under the agent %s filter', (status) => {
    const spec = machine.createSpec({ ticketId: 'AGENT-1', title: 'Generate SPEC' });
    spec.automation = { enabled: true, status, attempt: 1 };
    expect(spec.execution.status).toBe('ready');
    expect(boardStatus(spec)).toBe(status);
    expect(filterSpecs([spec], readBoardFilters(new URLSearchParams('status=' + status)))).toEqual([spec]);
    expect(filterSpecs([spec], readBoardFilters(new URLSearchParams('status=ready')))).toEqual([]);
  });

  it.each(['paused', 'completed'] as const)('keeps execution %s above stale agent state', (status) => {
    const spec = machine.createSpec({ ticketId: 'AGENT-2', title: 'Stopped execution' });
    spec.execution.status = status;
    spec.automation = { enabled: true, status: 'running', attempt: 1 };
    expect(boardStatus(spec)).toBe(status);
    expect(filterSpecs([spec], readBoardFilters(new URLSearchParams('status=running')))).toEqual([]);
  });

  it('maps a queued agent to ready and ignores disabled agent failures', () => {
    const spec = machine.createSpec({ ticketId: 'AGENT-3', title: 'Queued execution' });
    spec.execution.status = 'waiting_review';
    spec.automation = { enabled: true, status: 'queued', attempt: 1 };
    expect(boardStatus(spec)).toBe('ready');
    spec.automation = { enabled: false, status: 'failed', attempt: 1 };
    expect(boardStatus(spec)).toBe('waiting_review');
  });
});
