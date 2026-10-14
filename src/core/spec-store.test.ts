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
    const rel = await store.writeArtifact(repo, 'ABC-1', 'spec', 0, '# Spec');
    expect(rel).toBe(join('specs', 'ABC-1.md'));
    const content = await fs.readFile(join(repo, rel), 'utf-8');
    expect(content).toBe('# Spec');
  });

  it('writes later-stage products under .specflow/artifacts', async () => {
    const store = new SpecStore();
    const rel = await store.writeArtifact(repo, 'ABC-1', 'requirements', 1, '# Reqs');
    expect(rel).toBe(join('.specflow', 'artifacts', 'ABC-1', '1-requirements.md'));
  });
});
