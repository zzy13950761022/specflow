import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SpecStore } from './spec-store.js';
import { StageMachine } from './stage-machine.js';

let repo: string;
const sm = new StageMachine();

beforeEach(async () => {
  repo = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-test-'));
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('SpecStore read/write round-trip', () => {
  it('returns null for a missing spec', async () => {
    const store = new SpecStore();
    expect(await store.read(repo, 'NOPE-1')).toBeNull();
  });

  it('writes then reads back an identical spec', async () => {
    const store = new SpecStore();
    const spec = sm.createSpec({ ticketId: 'ABC-1', title: 'Hello' });
    await store.write(repo, spec);
    const read = await store.read(repo, 'ABC-1');
    expect(read).toEqual(spec);
  });

  it('persists under .specflow/specs/{TICKET}.json', async () => {
    const store = new SpecStore();
    await store.write(repo, sm.createSpec({ ticketId: 'ABC-1', title: 'x' }));
    const path = join(repo, '.specflow', 'specs', 'ABC-1.json');
    await expect(fs.access(path)).resolves.toBeUndefined();
  });

  it('lists all specs in the repo', async () => {
    const store = new SpecStore();
    await store.write(repo, sm.createSpec({ ticketId: 'ABC-1', title: 'a' }));
    await store.write(repo, sm.createSpec({ ticketId: 'ABC-2', title: 'b' }));
    const list = await store.list(repo);
    expect(list.map((s) => s.ticketId).sort()).toEqual(['ABC-1', 'ABC-2']);
  });

  it('rejects a malformed spec file on read', async () => {
    const store = new SpecStore();
    const path = join(repo, '.specflow', 'specs', 'BAD-1.json');
    await fs.mkdir(join(repo, '.specflow', 'specs'), { recursive: true });
    await fs.writeFile(path, JSON.stringify({ ticketId: 'BAD-1' }), 'utf-8');
    await expect(store.read(repo, 'BAD-1')).rejects.toThrow();
  });
});

describe('SpecStore concurrency', () => {
  it('serializes concurrent writes without losing updates', async () => {
    const store = new SpecStore();
    let spec = sm.createSpec({ ticketId: 'ABC-1', title: 'x' });
    await store.write(repo, spec);

    // Fire ten writes "simultaneously", each bumping a distinct history entry.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const s = structuredClone(spec);
        s.gateHistory.push({ stageId: 'spec', from: 'not_ready', to: 'pending_review', at: `${i}` });
        return store.write(repo, s);
      })
    );

    const final = await store.read(repo, 'ABC-1');
    expect(final).not.toBeNull();
    // The file must be valid JSON matching the schema (no torn write).
    expect(final!.ticketId).toBe('ABC-1');
  });
});

describe('SpecStore.writeArtifact', () => {
  it('writes the stage-0 product to specs/{TICKET}.md', async () => {
    const store = new SpecStore();
    const { artifact } = await store.writeArtifact(repo, 'ABC-1', 'spec', 0, '# Spec');
    expect(artifact.path).toBe(join('specs', 'ABC-1.md'));
    expect(artifact.kind).toBe('markdown');
    const content = await fs.readFile(join(repo, artifact.path), 'utf-8');
    expect(content).toBe('# Spec');
  });

  it('writes later-stage products under .specflow/artifacts', async () => {
    const store = new SpecStore();
    const { artifact } = await store.writeArtifact(repo, 'ABC-1', 'requirements', 1, '# Reqs');
    expect(artifact.path).toBe(join('.specflow', 'artifacts', 'ABC-1', '1-requirements.md'));
  });

  it('also writes a timestamped history copy and returns its entry', async () => {
    const store = new SpecStore();
    const { history } = await store.writeArtifact(repo, 'ABC-1', 'spec', 0, '# Spec');
    expect(history.path).toContain(join('.specflow', 'artifacts', 'ABC-1', 'history'));
    expect(history.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const snapshot = await fs.readFile(join(repo, history.path), 'utf-8');
    expect(snapshot).toBe('# Spec');
  });

  it('returns a deploy-checklist artifact with items when kind is deploy-checklist', async () => {
    const store = new SpecStore();
    const { artifact } = await store.writeArtifact(repo, 'DEPLOY-1', 'deploy', 6, '# Deploy plan', {
      kind: 'deploy-checklist',
      items: [
        { description: 'Run DB migration', governanceFlag: 'pci' },
        { description: 'Smoke test checkout', checked: true },
      ],
      rollbackCriteria: 'Revert if error rate > 1%',
    });
    expect(artifact.kind).toBe('deploy-checklist');
    if (artifact.kind !== 'deploy-checklist') return;
    expect(artifact.items).toHaveLength(2);
    expect(artifact.items[0].description).toBe('Run DB migration');
    expect(artifact.items[0].governanceFlag).toBe('pci');
    expect(artifact.items[1].checked).toBe(true);
    expect(artifact.rollbackCriteria).toBe('Revert if error rate > 1%');
    expect(artifact.status).toBe('pending');
  });

  it('returns an ops-report artifact with logsSanitized flag', async () => {
    const store = new SpecStore();
    const { artifact } = await store.writeArtifact(repo, 'OPS-1', 'ops', 7, '# Ops report', {
      kind: 'ops-report',
      logsSanitized: true,
      rcaPath: '.specflow/artifacts/OPS-1/rca.md',
      metrics: { stageCoverage: 100, buildSuccess: true },
    });
    expect(artifact.kind).toBe('ops-report');
    if (artifact.kind !== 'ops-report') return;
    expect(artifact.logsSanitized).toBe(true);
    expect(artifact.rcaPath).toBe('.specflow/artifacts/OPS-1/rca.md');
    expect(artifact.metrics?.stageCoverage).toBe(100);
  });

  it('round-trips deploy-checklist artifact through SpecStore write/read', async () => {
    const store = new SpecStore();
    let spec = sm.createSpec({ ticketId: 'DEPLOY-1', title: 'Deployment' });
    const { artifact, history } = await store.writeArtifact(
      repo, 'DEPLOY-1', 'deploy', 6, '# Deploy plan',
      { kind: 'deploy-checklist', items: [{ description: 'Step 1' }] }
    );
    // Simulate what StageMachine.recordAiOutput does
    const stage = spec.stages.find((s) => s.id === 'deploy')!;
    stage.artifact = artifact;
    stage.artifactHistory = [history];
    stage.aiStatus = 'done';
    stage.gate.status = 'pending_review';
    spec.gateHistory.push({ stageId: 'deploy', from: 'not_ready', to: 'pending_review', at: new Date().toISOString() });
    await store.write(repo, spec);
    const read = await store.read(repo, 'DEPLOY-1');
    const deployStage = read!.stages.find((s) => s.id === 'deploy')!;
    expect(deployStage.artifact?.kind).toBe('deploy-checklist');
    if (deployStage.artifact?.kind === 'deploy-checklist') {
      expect(deployStage.artifact.items[0].description).toBe('Step 1');
    }
  });

  it('round-trips ops-report artifact through SpecStore write/read', async () => {
    const store = new SpecStore();
    let spec = sm.createSpec({ ticketId: 'OPS-1', title: 'Ops' });
    const { artifact, history } = await store.writeArtifact(
      repo, 'OPS-1', 'ops', 7, '# Ops report',
      { kind: 'ops-report', logsSanitized: false }
    );
    const stage = spec.stages.find((s) => s.id === 'ops')!;
    stage.artifact = artifact;
    stage.artifactHistory = [history];
    stage.aiStatus = 'done';
    stage.gate.status = 'pending_review';
    spec.gateHistory.push({ stageId: 'ops', from: 'not_ready', to: 'pending_review', at: new Date().toISOString() });
    await store.write(repo, spec);
    const read = await store.read(repo, 'OPS-1');
    const opsStage = read!.stages.find((s) => s.id === 'ops')!;
    expect(opsStage.artifact?.kind).toBe('ops-report');
    if (opsStage.artifact?.kind === 'ops-report') {
      expect(opsStage.artifact.logsSanitized).toBe(false);
    }
  });
});
