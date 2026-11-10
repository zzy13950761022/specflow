import { promises as fs } from 'fs';
import { join, relative, resolve, sep } from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { z } from 'zod';
import type { CheckEvidence } from './schemas.js';

const CommandSchema = z.object({
  command: z.string().min(1), args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1).max(600_000).default(120_000), coverageReport: z.string().optional(),
});
const GeneratedPathSchema = z.string().min(1).refine((path) =>
  path === path.trim() && !/[\\:*?\[\]\r\n\0]/.test(path) &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  'generatedPaths must contain exact repository-relative file or directory paths without traversal or globs.'
);
const ConfigSchema = z.object({
  test: CommandSchema.optional(), build: CommandSchema.optional(),
  generatedPaths: z.array(GeneratedPathSchema).default([]),
});
const IGNORED_NAMES = new Set(['.git', '.specflow', 'node_modules']);
const GENERATED_PATHS = new Set(['dist', 'build', 'coverage', 'test-results', 'playwright-report', '.playwright-mcp', 'dashboard_frontend/dist']);
// Do not launch repository commands until their process-group owner is durable.
// If the controller dies before authorization, stdin closes and the wrapper exits.
const CHECK_BOOTSTRAP = `
const {spawn} = require('child_process');
let started = false;
process.stdin.once('data', () => {
  started = true;
  const child = spawn(process.argv[1], process.argv.slice(2), {stdio: ['ignore', 'inherit', 'inherit']});
  child.on('error', error => {console.error(error.message); process.exitCode = 1;});
  child.on('close', code => process.exit(code ?? 1));
});
process.stdin.on('end', () => {if (!started) process.exit(1);});
`;

async function writeCheckOwner(lock: string, owner: { pid: number; runId: string; childPid?: number }) {
  const temporary = join(lock, randomUUID() + '.tmp');
  try {
    await fs.writeFile(temporary, JSON.stringify(owner));
    await fs.rename(temporary, join(lock, 'owner.json'));
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function fingerprint(repoPath: string): Promise<string> {
  const rawConfig = await fs.readFile(join(repoPath, '.specflow', 'checks.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return '{}';
  });
  const generatedPaths = [...new Set(ConfigSchema.parse(JSON.parse(rawConfig)).generatedPaths)].sort();
  const hash = createHash('sha256');
  // Bind evidence to the exclusion policy, including checks at approval/advance.
  // Version this change so earlier evidence cannot use a different file scope.
  hash.update('fingerprint-v2\0');
  hash.update(JSON.stringify(generatedPaths));
  hash.update('\0');
  async function walk(dir: string) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const rel = relative(repoPath, path).split(sep).join('/');
      if (IGNORED_NAMES.has(entry.name) || GENERATED_PATHS.has(rel) ||
          generatedPaths.some((output) => rel === output || rel.startsWith(output + '/'))) continue;
      if (entry.isSymbolicLink()) { hash.update(relative(repoPath, path)); hash.update(await fs.readlink(path)); }
      else if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) { hash.update(relative(repoPath, path)); hash.update(Buffer.from([0])); hash.update(await fs.readFile(path)); hash.update(Buffer.from([0])); }
    }
  }
  await walk(repoPath);
  return hash.digest('hex');
}

async function coveragePath(repo: string, report: string): Promise<string> {
  const root = await fs.realpath(repo);
  const path = resolve(root, report);
  const rel = relative(root, path);
  if (!rel.startsWith('coverage' + sep) || !path.endsWith('.json')) throw new Error('coverageReport must be a JSON file inside coverage/.');
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    const stat = await fs.lstat(cursor).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error('coverageReport must not traverse symlinks.');
  }
  return path;
}

export async function runCheck(repo: string, ticketId: string, stageId: 'test' | 'build', runId = randomUUID()): Promise<CheckEvidence> {
  const root = await fs.realpath(repo);
  const lock = join(root, '.specflow', 'repository-check.lock');
  await fs.mkdir(join(root, '.specflow'), { recursive: true });
  try { await fs.mkdir(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A repository check is already running. Retry after it completes or recover interrupted execution.');
    throw error;
  }
  try {
    await writeCheckOwner(lock, { pid: process.pid, runId });
    return await executeCheck(root, ticketId, stageId, runId, lock);
  } finally { await fs.rm(lock, { recursive: true, force: true }); }
}

/** Explicit recovery never releases a lock while its owner or command is alive. */
export async function recoverRepositoryCheck(repo: string): Promise<void> {
  const lock = join(await fs.realpath(repo), '.specflow', 'repository-check.lock');
  const recovery = lock + '.recovery';
  if (!await lockMayBeRecovered(lock)) return;
  if (await lockMayBeRecovered(recovery)) await fs.rm(recovery, { recursive: true, force: true });
  try { await fs.mkdir(recovery); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    await fs.writeFile(join(recovery, 'owner.json'), JSON.stringify({ pid: process.pid }));
    if (await lockMayBeRecovered(lock)) await fs.rm(lock, { recursive: true, force: true });
  } finally { await fs.rm(recovery, { recursive: true, force: true }); }
}

async function lockMayBeRecovered(lock: string): Promise<boolean> {
  try {
    const owner = z.object({ pid: z.number().int().positive(), childPid: z.number().int().positive().optional() }).parse(JSON.parse(await fs.readFile(join(lock, 'owner.json'), 'utf8')));
    for (const pid of [owner.pid, owner.childPid].filter((pid): pid is number => pid !== undefined)) {
      try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
    }
    return true;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const stat = await fs.stat(lock).catch(() => null);
    return !!stat && Date.now() - stat.mtimeMs > 30_000;
  }
}

async function executeCheck(repo: string, ticketId: string, stageId: 'test' | 'build', runId: string, lock: string): Promise<CheckEvidence> {
  const config = ConfigSchema.parse(JSON.parse(await fs.readFile(join(repo, '.specflow', 'checks.json'), 'utf8')));
  const command = config[stageId];
  if (!command) throw new Error('Configure ' + stageId + ' in .specflow/checks.json before running checks.');
  const report = stageId === 'test' && command.coverageReport ? await coveragePath(repo, command.coverageReport) : undefined;
  if (report) await fs.rm(report, { force: true });
  const before = await fingerprint(repo);
  const startedAt = new Date().toISOString();
  let output = ''; let bytes = 0; let outputTruncated = false; let timedOut = false;
  const exitCode = await new Promise<number | null>((resolveRun) => {
    const child = spawn(process.execPath, ['-e', CHECK_BOOTSTRAP, '--', command.command, ...command.args], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    function kill(signal: NodeJS.Signals) {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
    }
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); forceTimer = setTimeout(() => kill('SIGKILL'), 100); }, command.timeoutMs);
    const collect = (chunk: Buffer) => {
      const room = Math.max(0, 1_048_576 - bytes);
      output += chunk.subarray(0, room).toString('utf8'); bytes += chunk.length;
      if (bytes > 1_048_576) outputTruncated = true;
    };
    child.stdout?.on('data', collect); child.stderr?.on('data', collect);
    child.on('error', (err) => { output += String.fromCharCode(10) + err.message; });
    child.stdin.on('error', () => { /* process exited before authorization */ });
    child.on('close', (code) => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); resolveRun(code); });
    if (child.pid) void writeCheckOwner(lock, { pid: process.pid, childPid: child.pid, runId }).then(() => {
      child.stdin.end('run');
    }).catch((error) => { output += String.fromCharCode(10) + String(error); kill('SIGKILL'); });
  });
  let coverage: number | undefined;
  if (report) {
    try {
      const data = JSON.parse(await fs.readFile(report, 'utf8'));
      const lines = z.object({ pct: z.number().min(0).max(100), total: z.number().positive(), covered: z.number().nonnegative() }).parse(data.total?.lines);
      if (lines.covered <= lines.total) coverage = Math.min(lines.pct / 100, lines.covered / lines.total);
    } catch { /* Missing/invalid report remains insufficient evidence. */ }
  }
  const codeChanged = before !== await fingerprint(repo);
  const outputPath = join('.specflow', 'evidence', ticketId, runId + '.log');
  await fs.mkdir(join(repo, '.specflow', 'evidence', ticketId), { recursive: true });
  await fs.writeFile(join(repo, outputPath), output, 'utf8');
  const evidence: CheckEvidence = {
    runId, stageId, command: command.command, args: command.args, exitCode,
    startedAt, finishedAt: new Date().toISOString(), codeFingerprint: before,
    codeChanged, timedOut, outputTruncated, outputPath, coverage,
  };
  await fs.writeFile(join(repo, '.specflow', 'evidence', ticketId, runId + '.json'), JSON.stringify(evidence, null, 2));
  return evidence;
}

export function assertEvidence(evidence: CheckEvidence | undefined, stageId: 'test' | 'build', currentFingerprint?: string): void {
  if (!evidence || evidence.stageId !== stageId || evidence.exitCode !== 0 || evidence.timedOut || evidence.codeChanged || evidence.outputTruncated) {
    throw new Error('Run a successful platform ' + stageId + ' check before approving or advancing.');
  }
  if (currentFingerprint !== undefined && currentFingerprint !== evidence.codeFingerprint) throw new Error('Code changed since verification. Run the check again.');
  if (stageId === 'test' && (evidence.coverage === undefined || evidence.coverage < 0.8)) throw new Error('Actual line coverage >= 80% is required; configure a fresh coverage report.');
}
