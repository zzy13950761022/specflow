import { it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { prepareWorktree } from './workspaces.js';

it('creates separate ticket worktrees and reuses them without switching the checkout', async () => {
  const repo = await fs.mkdtemp(join(tmpdir(), 'pilot-worktree-'));
  try {
    execFileSync('git', ['init', '-q', repo]); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'Initial']);
    const first = await prepareWorktree(repo, 'T-1'); const second = await prepareWorktree(repo, 'T-2');
    expect(first).not.toBe(second); expect(await prepareWorktree(repo, 'T-1')).toBe(first);
    await fs.writeFile(join(first, 'change.txt'), 'isolated');
    await expect(fs.stat(join(repo, 'change.txt'))).rejects.toThrow(); await expect(fs.stat(join(second, 'change.txt'))).rejects.toThrow();
    expect(execFileSync('git', ['-C', first, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()).toBe(first);
  } finally { await fs.rm(repo, { recursive: true, force: true }); }
});
