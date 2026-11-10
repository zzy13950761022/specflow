import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StageMachine } from '../../../src/core/stage-machine';
import { StagePanel } from './StagePanel';

it('does not label an ungenerated stage as an outdated artifact', () => {
  const spec = new StageMachine().createSpec({ ticketId: 'BUG-1', title: 'Fix' });
  const stage = spec.stages[3];
  // Upstream rework may invalidate a stage before any artifact exists.
  stage.stale = true;
  stage.staleReason = 'Upstream rework';
  const html = renderToStaticMarkup(<StagePanel repoId="repo" ticketId="BUG-1" spec={spec} stage={stage} />);
  expect(html).not.toContain('Outdated artifact');
});

it('still warns when rework invalidates an existing artifact', () => {
  const spec = new StageMachine().createSpec({ ticketId: 'BUG-1', title: 'Fix' });
  const stage = spec.stages[3];
  stage.artifact = { kind: 'markdown', path: 'old-plan.md' };
  stage.stale = true;
  stage.staleReason = 'Implementation plan changed';
  const html = renderToStaticMarkup(<StagePanel repoId="repo" ticketId="BUG-1" spec={spec} stage={stage} />);
  expect(html).toContain('Outdated artifact');
  expect(html).toContain('Implementation plan changed');
});
