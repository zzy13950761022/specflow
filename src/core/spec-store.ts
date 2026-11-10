import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { SpecFileSchema, type SpecFile, type StageId, type Artifact, type ArtifactInput } from './schemas.js';
import { isCompletedLegacySpec, restoreLegacyCompletion } from './legacy-completion.js';

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
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ticketId)) throw new Error('ticketId must contain only letters, numbers, dots, underscores or hyphens and start with a letter or number.');
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
      const spec = SpecFileSchema.parse(JSON.parse(raw));
      if (isCompletedLegacySpec(spec)) return restoreLegacyCompletion(spec);
      if (spec.schemaVersion < 3) {
        spec.schemaVersion = 3;
        for (const stage of spec.stages) {
          stage.subtasks?.forEach((task) => { task.completed = false; task.status = 'pending'; task.claimId = undefined; task.attempt++; });
          if (stage.artifact) stage.revision = Math.max(stage.revision, 1);
          if (stage.gate.status === 'approved') {
            stage.gate.status = 'pending_review';
            stage.gate.approvedRevision = undefined;
          }
        }
        spec.currentStageId = 'spec';
      }
      return spec;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Validate + atomically persist a spec file. */
  async write(repoPath: string, spec: SpecFile): Promise<SpecFile> {
    const validated = SpecFileSchema.parse(spec);
    return this.transaction(repoPath, spec.ticketId, async () => validated);
  }

  /** Disk lock includes the read and domain mutation, shared by independent processes. */
  async transaction(repoPath: string, ticketId: string, mutate: (spec: SpecFile | null) => Promise<SpecFile>): Promise<SpecFile> {
    return this.withLock(repoPath, ticketId, async () => {
      const target = this.specJsonPath(repoPath, ticketId);
      const lock = `${target}.lock`;
      await fs.mkdir(dirname(target), { recursive: true });
      const deadline = Date.now() + 10_000;
      for (;;) {
        try { await fs.mkdir(lock); break; } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          try {
            const owner = JSON.parse(await fs.readFile(join(lock, 'owner.json'), 'utf8'));
            try { process.kill(owner.pid, 0); } catch (e) {
              if ((e as NodeJS.ErrnoException).code === 'ESRCH') await fs.rm(lock, { recursive: true, force: true });
            }
          } catch {
            const stat = await fs.stat(lock).catch(() => null);
            if (stat && Date.now() - stat.mtimeMs > 30_000) await fs.rm(lock, { recursive: true, force: true });
          }
          if (Date.now() >= deadline) throw new Error('Ticket is busy; retry the operation.');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      try {
        await fs.writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
        const spec = SpecFileSchema.parse(await mutate(await this.read(repoPath, ticketId)));
        await this.atomicWrite(target, JSON.stringify(spec, null, 2));
        return spec;
      } finally { await fs.rm(lock, { recursive: true, force: true }); }
    });
  }

  /**
   * Write a stage's AI artifact plus a timestamped history copy. Returns the
   * typed Artifact (with canonical path set) and a history entry.
   * - markdown kinds write content to a .md file
   * - structured kinds (deploy-checklist, ops-report) serialize their fields
   *   to JSON at a .json sidecar path; the `path` in the returned artifact
   *   points to a human-readable .md summary for backward compat
   */
  async writeArtifact(
    repoPath: string,
    ticketId: string,
    stageId: StageId,
    stageIndex: number,
    content: string,
    specPath: string,
    artifactInput?: ArtifactInput
  ): Promise<{ artifact: Artifact; history: { path: string; at: string; artifact: Artifact } }> {
    const kind = artifactInput?.kind ?? 'markdown';
    const rel =
      stageId === 'spec'
        ? // Stage 0 product is the canonical human spec; its path is owned by
          // the spec's specPath (.specflow/specs/{ticketId}-{slug}.md).
          specPath
        : join('.specflow', 'artifacts', ticketId, `${stageIndex}-${stageId}.md`);

    await this.atomicWrite(join(repoPath, rel), content);

    const at = new Date().toISOString();
    const historyRel = join(
      '.specflow',
      'artifacts',
      ticketId,
      'history',
      `${stageId}-${at.replace(/[:.]/g, '-')}-${randomUUID()}.md`
    );
    await this.atomicWrite(join(repoPath, historyRel), content);

    let artifact: Artifact;
    if (kind === 'deploy-checklist' && artifactInput?.kind === 'deploy-checklist') {
      artifact = {
        kind: 'deploy-checklist',
        path: rel,
        items: (artifactInput.items ?? []).map((item) => ({
          id: item.id ?? crypto.randomUUID(),
          description: item.description,
          checked: item.checked ?? false,
          governanceFlag: item.governanceFlag ?? 'none',
        })),
        status: artifactInput.status ?? 'pending',
        rollbackCriteria: artifactInput.rollbackCriteria,
      };
    } else if (kind === 'ops-report' && artifactInput?.kind === 'ops-report') {
      artifact = {
        kind: 'ops-report',
        path: rel,
        logsSanitized: artifactInput.logsSanitized,
        rcaPath: artifactInput.rcaPath,
        runbookPath: artifactInput.runbookPath,
        metrics: artifactInput.metrics,
      };
    } else if (kind === 'requirements' && artifactInput?.kind === 'requirements') {
      // Structured data lives in a JSON sidecar next to the markdown summary.
      const dataRel = join('.specflow', 'artifacts', ticketId, `${stageIndex}-${stageId}.json`);
      await this.atomicWrite(
        join(repoPath, dataRel),
        JSON.stringify(artifactInput.data, null, 2)
      );
      artifact = { kind: 'requirements', path: rel, dataPath: dataRel };
    } else {
      artifact = {
        kind: 'markdown',
        path: rel,
        ...(artifactInput?.kind === 'markdown' && artifactInput.metrics
          ? { metrics: artifactInput.metrics }
          : {}),
      };
    }

    let historicalArtifact: Artifact = { ...artifact, path: historyRel };
    if (artifact.kind === 'requirements' && artifactInput?.kind === 'requirements') {
      const dataPath = historyRel.slice(0, -3) + '.json';
      await this.atomicWrite(join(repoPath, dataPath), JSON.stringify(artifactInput.data, null, 2));
      historicalArtifact = { ...artifact, path: historyRel, dataPath };
    }
    return { artifact, history: { path: historyRel, at, artifact: historicalArtifact } };
  }

  /** Atomic file write (temp + rename), creating parent dirs as needed. */
  private async atomicWrite(abs: string, content: string): Promise<void> {
    await fs.mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, abs);
  }
}
