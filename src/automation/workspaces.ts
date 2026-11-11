import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join } from 'path';
const exec = promisify(execFile);
export async function git(repo: string, args: string[]): Promise<string> {
  return (await exec('git', ['-C', repo, ...args], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 })).stdout;
}
export async function prepareWorktree(repo: string, ticketId: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ticketId)) throw new Error('Invalid ticket ID.');
  const root = await fs.realpath(repo);
  const path = join(root, '.specflow', 'worktrees', ticketId);
  try {
    const registered = (await git(path, ['rev-parse', '--show-toplevel'])).trim();
    if (registered !== path || (await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim() !== (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()) throw new Error('Ticket worktree belongs to a different repository.');
    return path;
  } catch (error) { if (await fs.stat(path).catch(() => null)) throw error; }
  const dirty = await git(root, ['status', '--porcelain', '--untracked-files=normal', '--', '.', ':(exclude).specflow']);
  if (dirty.trim()) throw new Error('Commit or stash source changes before starting an isolated ticket worktree.');
  await fs.mkdir(join(root, '.specflow', 'worktrees'), { recursive: true });
  await git(root, ['worktree', 'add', '-b', 'specflow/' + ticketId, path, 'HEAD']);
  await fs.mkdir(join(path, '.specflow'), { recursive: true });
  try { await fs.copyFile(join(root, '.specflow', 'checks.json'), join(path, '.specflow', 'checks.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return path;
}
