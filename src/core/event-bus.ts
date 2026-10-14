import type { SpecFile } from './schemas.js';

/**
 * In-process pub/sub. Every state mutation publishes here; the dashboard WS
 * layer and the file watcher both subscribe, so the browser always reflects
 * disk (Invariant #2).
 */

export type DomainEvent =
  | { type: 'spec.created'; repoId: string; spec: SpecFile }
  | { type: 'spec.updated'; repoId: string; spec: SpecFile }
  | { type: 'repo.added'; repoId: string; path: string }
  | { type: 'repo.removed'; repoId: string };

type Listener = (event: DomainEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: DomainEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A failing subscriber must never break the mutation that emitted.
      }
    }
  }
}
