import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { SpecFileSchema, type SpecFile, type StageId } from './schemas.js';

/**
 * Reads/writes spec files inside a repo's .specflow directory. Files are the
 * source of truth (Invariant #2). Writes are atomic (temp + rename), validated
 * with zod on read, and serialized per-ticket with an async mutex so a Claude
 * write and a dashboard approve can't interleave.
 */
export class SpecStore {
  /** repoPath -> ticketId -> tail of the write chain */
  private locks = new Map<string, Promise<unknown>>();

  private specflowDir(repoPath: string): string {
    return join(repoPath, '.specflow');
  }

  private specJsonPath(repoPath: string, ticketId: string): string {
    return join(this.specflowDir(repoPath), 'specs', `${ticketId}.json`);
  }

  private lockKey(repoPath: string, ticketId: string): string {
    return `${repoPath}::${ticketId}`;
  }

  /** Serialize writes per ticket; each op waits for the previous to settle. */
  private withLock<T>(repoPath: string, ticketId: string, op: () => Promise<T>): Promise<T> {
    const key = this.lockKey(repoPath, ticketId);
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.locks.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }

  async list(repoPath: string): Promise<SpecFile[]> {
    const dir = join(this.specflowDir(repoPath), 'specs');
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const specs: SpecFile[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const spec = await this.read(repoPath, name.replace(/\.json$/, ''));
      if (spec) specs.push(spec);
    }
    return specs;
  }

  async read(repoPath: string, ticketId: string): Promise<SpecFile | null> {
    try {
      const raw = await fs.readFile(this.specJsonPath(repoPath, ticketId), 'utf-8');
      return SpecFileSchema.parse(JSON.parse(raw));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Validate + atomically persist a spec file. */
  async write(repoPath: string, spec: SpecFile): Promise<SpecFile> {
    const validated = SpecFileSchema.parse(spec);
    return this.withLock(repoPath, spec.ticketId, async () => {
      const target = this.specJsonPath(repoPath, spec.ticketId);
      await fs.mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(validated, null, 2), 'utf-8');
      await fs.rename(tmp, target);
      return validated;
    });
  }

  /**
   * Write a stage's AI artifact plus a timestamped history copy. Returns the
   * canonical repo-relative path and the history entry (path + timestamp).
   */
  async writeArtifact(
    repoPath: string,
    ticketId: string,
    stageId: StageId,
    stageIndex: number,
    content: string
  ): Promise<{ path: string; history: { path: string; at: string } }> {
    const rel =
      stageId === 'spec'
        ? // Stage 0 product is the canonical human spec, lives in specs/.
          join('specs', `${ticketId}.md`)
        : join('.specflow', 'artifacts', ticketId, `${stageIndex}-${stageId}.md`);
    await this.atomicWrite(join(repoPath, rel), content);

    const at = new Date().toISOString();
    const historyRel = join(
      '.specflow',
      'artifacts',
      ticketId,
      'history',
      `${stageId}-${at.replace(/[:.]/g, '-')}.md`
    );
    await this.atomicWrite(join(repoPath, historyRel), content);

    return { path: rel, history: { path: historyRel, at } };
  }

  /** Atomic file write (temp + rename), creating parent dirs as needed. */
  private async atomicWrite(abs: string, content: string): Promise<void> {
    await fs.mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, abs);
  }
}
