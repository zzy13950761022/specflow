import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, resolve, basename } from 'path';
import { createHash } from 'crypto';

/**
 * A disposable pointer index of which repos the user added (Invariant #2: the
 * registry never owns truth, repos do). Lives at ~/.specflow/registry.json.
 * Removing a repo here never touches the repo's files.
 */

export interface RepoEntry {
  id: string;
  path: string;
  name: string;
  addedAt: string;
}

interface RegistryFile {
  repos: RepoEntry[];
}

function registryHome(): string {
  // SPEC_WORKFLOW_HOME-style escape hatch for sandboxed environments.
  const override = process.env.AI_PILOT_HOME;
  return override ? resolve(override) : join(homedir(), '.specflow');
}

function registryPath(): string {
  return join(registryHome(), 'registry.json');
}

function repoId(path: string): string {
  return createHash('sha1').update(resolve(path)).digest('hex').slice(0, 12);
}

export class RepoRegistry {
  private async load(): Promise<RegistryFile> {
    try {
      const raw = await fs.readFile(registryPath(), 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.repos)) return { repos: [] };
      return parsed;
    } catch {
      return { repos: [] };
    }
  }

  private async save(data: RegistryFile): Promise<void> {
    const target = registryPath();
    await fs.mkdir(registryHome(), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, target);
  }

  async list(): Promise<RepoEntry[]> {
    return (await this.load()).repos;
  }

  async resolve(id: string): Promise<RepoEntry | null> {
    const { repos } = await this.load();
    return repos.find((r) => r.id === id) ?? null;
  }

  /** Validate the path is a real directory, then index it (idempotent by path). */
  async add(path: string): Promise<RepoEntry> {
    const abs = resolve(path);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Not a directory: ${abs}`);
    }
    const data = await this.load();
    const id = repoId(abs);
    const existing = data.repos.find((r) => r.id === id);
    if (existing) return existing;

    const entry: RepoEntry = {
      id,
      path: abs,
      name: basename(abs),
      addedAt: new Date().toISOString(),
    };
    data.repos.push(entry);
    await this.save(data);
    return entry;
  }

  /** Remove from the index only. Never deletes repo files. */
  async remove(id: string): Promise<boolean> {
    const data = await this.load();
    const before = data.repos.length;
    data.repos = data.repos.filter((r) => r.id !== id);
    if (data.repos.length === before) return false;
    await this.save(data);
    return true;
  }
}
