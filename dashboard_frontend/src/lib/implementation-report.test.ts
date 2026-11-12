import { expect, it } from 'vitest';
import { presentImplementationReport, taskTitle } from './implementation-report';

it('presents immutable report summaries and source separately from internal logs', () => {
  const log = { subtaskId: 'A', summary: 'Added boundary tests.', filesModified: ['src/a.ts'], filesCreated: [], statistics: { linesAdded: 3, linesRemoved: 1 } };
  const fence = String.fromCharCode(96).repeat(3);
  const content = ['# Implementation review: A very long instruction', '', 'Source fingerprint: abc', '', 'Plan revision and task attempt are recorded with this report.', '', 'Added boundary tests.', '', fence + 'json', JSON.stringify(log), fence, '', '## Current source: src/a.ts', '', fence, '// source', '## this is code, not a report section', fence].join('\n');
  const result = presentImplementationReport(content);
  expect(result.summary).toBe('Added boundary tests.');
  expect(result.files).toEqual(['src/a.ts']);
  expect(result.sections).toEqual([{ title: 'Current source: src/a.ts', content: expect.stringContaining('## this is code, not a report section') }]);
  expect(result.statistics).toEqual({ linesAdded: 3, linesRemoved: 1 });
  expect(result.summary).not.toContain('fingerprint');
});

it('keeps unfamiliar or malformed content visible instead of discarding it', () => {
  const content = '# Custom report\n\nDetails that must remain.\n\n~~~json\n{invalid}\n~~~';
  expect(presentImplementationReport(content).summary).toBe(content);
});

it('keeps source blocks containing heading-like text intact', () => {
  const content = '# Implementation review: Task\n\nSummary\n\n## Current source: README.md\n\n~~~~md\n# Header\n## Subheading\n~~~~';
  expect(presentImplementationReport(content).sections).toHaveLength(1);
  expect(presentImplementationReport(content).sections[0].content).toContain('## Subheading');
});

it('uses concise explicit titles and shortens legacy descriptions without changing them', () => {
  expect(taskTitle({ title: 'Boundary tests', description: 'Long instructions' })).toBe('Boundary tests');
  expect(taskTitle({ description: 'Validate shipping. Full implementation details follow.' })).toBe('Validate shipping');
  const description = '长任务说明'.repeat(30);
  expect(Array.from(taskTitle({ description })).length).toBeLessThanOrEqual(49);
  expect(description).toBe('长任务说明'.repeat(30));
});
