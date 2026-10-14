import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RepoRegistry } from './repo-registry.js';

let home: string;
let repoA: string;

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-home-'));
  repoA = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-repoA-'));
  process.env.AI_PILOT_HOME = home;
});

afterEach(async () => {
  delete process.env.AI_PILOT_HOME;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(repoA, { recursive: true, force: true });
});

describe('RepoRegistry', () => {
  it('starts empty', async () => {
    expect(await new RepoRegistry().list()).toEqual([]);
  });

  it('adds a repo by path and lists it', async () => {
    const reg = new RepoRegistry();
    const entry = await reg.add(repoA);
    expect(entry.path).toBe(repoA);
    expect(await reg.list()).toHaveLength(1);
  });

  it('is idempotent — adding the same path twice yields one entry', async () => {
    const reg = new RepoRegistry();
    const a = await reg.add(repoA);
    const b = await reg.add(repoA);
    expect(a.id).toBe(b.id);
    expect(await reg.list()).toHaveLength(1);
  });

  it('rejects a non-directory path', async () => {
    const reg = new RepoRegistry();
    await expect(reg.add(join(repoA, 'does-not-exist'))).rejects.toThrow();
  });

  it('resolves a repo by id', async () => {
    const reg = new RepoRegistry();
    const entry = await reg.add(repoA);
    expect((await reg.resolve(entry.id))?.path).toBe(repoA);
  });

  it('remove deletes the index entry but NOT the repo files', async () => {
    const reg = new RepoRegistry();
    const entry = await reg.add(repoA);
    const marker = join(repoA, 'keep.txt');
    await fs.writeFile(marker, 'hi');

    const removed = await reg.remove(entry.id);
    expect(removed).toBe(true);
    expect(await reg.list()).toHaveLength(0);
    // Repo files survive.
    await expect(fs.readFile(marker, 'utf-8')).resolves.toBe('hi');
  });

  it('persists across registry instances', async () => {
    await new RepoRegistry().add(repoA);
    expect(await new RepoRegistry().list()).toHaveLength(1);
  });
});
