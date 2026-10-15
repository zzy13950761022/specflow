import chokidar, { type FSWatcher } from 'chokidar';
import { join } from 'path';
import type { AppCore } from './app-core.js';
import type { RepoEntry } from './repo-registry.js';
import { logger } from './logger.js';

/**
 * Watches each registered repo's .specflow/specs directory for external edits
 * (e.g. the MCP process — "Claude" — writing a spec while the dashboard runs in
 * a different process). On change it re-reads the spec and re-emits a
 * spec.updated event so the dashboard board self-heals (Invariant #2).
 *
 * Without this, mutations made by a different process than the one hosting the
 * dashboard's EventBus would never reach the browser.
 */
export class FileWatcher {
  private watchers = new Map<string, FSWatcher>();

  constructor(private readonly app: AppCore) {}

  async start(): Promise<void> {
    const repos = await this.app.listRepos();
    for (const repo of repos) this.watchRepo(repo);

    // Pick up repos added after start.
    this.app.events.subscribe((event) => {
      if (event.type === 'repo.added') {
        this.app.registry.resolve(event.repoId).then((entry) => {
          if (entry) this.watchRepo(entry);
        });
      }
      if (event.type === 'repo.removed') this.unwatch(event.repoId);
    });
  }

  private watchRepo(repo: RepoEntry): void {
    if (this.watchers.has(repo.id)) return;
    // Watch the repo root (always exists) for the nested spec json files.
    // The .specflow/specs dir is created lazily on the first spec write, so
    // watching the leaf directly would miss it. depth 3 reaches
    // <repo>/.specflow/specs/*.json. Polling makes cross-process writes
    // reliable on macOS.
    const watcher = chokidar.watch(join(repo.path, '.specflow'), {
      ignoreInitial: true,
      usePolling: true,
      interval: 120,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    const onChange = (path: string) => {
      if (!path.endsWith('.json')) return;
      if (!path.includes(join('.specflow', 'specs'))) return;
      const ticketId = path.split('/').pop()!.replace(/\.json$/, '');
      this.reemit(repo.id, ticketId);
    };

    watcher.on('add', onChange).on('change', onChange);
    this.watchers.set(repo.id, watcher);
  }

  private async reemit(repoId: string, ticketId: string): Promise<void> {
    try {
      const spec = await this.app.getSpec(repoId, ticketId);
      if (spec) this.app.events.emit({ type: 'spec.updated', repoId, spec });
    } catch (err) {
      logger.warn('FileWatcher re-emit failed', repoId, ticketId, String(err));
    }
  }

  private async unwatch(repoId: string): Promise<void> {
    const watcher = this.watchers.get(repoId);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(repoId);
    }
  }

  async stop(): Promise<void> {
    for (const watcher of this.watchers.values()) await watcher.close();
    this.watchers.clear();
  }
}
