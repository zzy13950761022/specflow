import { promises as fs } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ImplementationLog, Subtask } from './schemas.js';
import { normalizedFile } from './task-scheduler.js';

const exec = promisify(execFile);
export async function implementationReport(repo: string, task: Subtask, source: string, logs: ImplementationLog[]): Promise<string> {
  const nl = String.fromCharCode(10); const fence = String.fromCharCode(96).repeat(3);
  const files = [...new Set(logs.flatMap((log) => [...log.filesModified, ...log.filesCreated]))].map(normalizedFile);
  const parts = ['# Implementation review: ' + task.description, 'Source fingerprint: ' + source, 'Plan revision and task attempt are recorded with this report.', ...logs.map((log) => log.summary + nl + fence + 'json' + nl + JSON.stringify(log, null, 2) + nl + fence)];
  try {
    const diff = (await exec('git', ['-C', repo, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...files], { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout;
    if (diff) parts.push('## Tracked source diff', fence + 'diff' + nl + diff + nl + fence);
  } catch { parts.push('Tracked diff unavailable. Inspect the source snapshots and workspace before approval.'); }
  let remaining = 1024 * 1024;
  for (const file of files) {
    const path = join(repo, file); const stat = await fs.lstat(path).catch(() => null);
    if (!stat) { parts.push('## ' + file, 'File is absent or deleted.'); continue; }
    if (stat.isSymbolicLink()) { parts.push('## ' + file, 'Symbolic link: ' + await fs.readlink(path)); continue; }
    if (!stat.isFile() || stat.size > remaining) { parts.push('## ' + file, 'Snapshot omitted due to the report size limit; inspect this file in the workspace.'); continue; }
    remaining -= stat.size;
    parts.push('## Current source: ' + file, fence + nl + await fs.readFile(path, 'utf8') + nl + fence);
  }
  return parts.join(nl + nl);
}
