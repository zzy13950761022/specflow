import { RepoRegistry, type RepoEntry } from './repo-registry.js';
import { SpecStore } from './spec-store.js';
import { StageMachine } from './stage-machine.js';
import { EventBus } from './event-bus.js';
import { PromptTemplates, type ResolvedTemplate, type TemplateSummary } from '../prompts/templates.js';
import { STAGE_IDS, type SpecFile, type StageId } from './schemas.js';
import { logger } from './logger.js';
import type { RepoBrief } from './repo-introspector.js';

/**
 * The shared singleton. Both the MCP server and the dashboard talk ONLY to
 * AppCore — never to the stores directly — so all gating rules and the
 * mutate->persist->emit flow live in exactly one place (Invariant #2).
 */
export class AppCore {
  readonly registry = new RepoRegistry();
  readonly store = new SpecStore();
  readonly stageMachine = new StageMachine();
  readonly templates = new PromptTemplates();
  readonly events = new EventBus();

  /* ---- repos ---- */

  listRepos(): Promise<RepoEntry[]> {
    return this.registry.list();
  }

  async addRepo(path: string): Promise<RepoEntry> {
    const entry = await this.registry.add(path);
    this.events.emit({ type: 'repo.added', repoId: entry.id, path: entry.path });
    return entry;
  }

  async removeRepo(id: string): Promise<boolean> {
    const ok = await this.registry.remove(id);
    if (ok) this.events.emit({ type: 'repo.removed', repoId: id });
    return ok;
  }

  private async repoPath(repoId: string): Promise<string> {
    const entry = await this.registry.resolve(repoId);
    if (!entry) throw new Error(`Unknown repo: ${repoId}`);
    return entry.path;
  }

  /* ---- specs ---- */

  async listSpecs(repoId: string): Promise<SpecFile[]> {
    return this.store.list(await this.repoPath(repoId));
  }

  async getSpec(repoId: string, ticketId: string): Promise<SpecFile | null> {
    return this.store.read(await this.repoPath(repoId), ticketId);
  }

  async createSpec(repoId: string, ticketId: string, title: string): Promise<SpecFile> {
    const path = await this.repoPath(repoId);
    const existing = await this.store.read(path, ticketId);
    if (existing) throw new Error(`Spec already exists: ${ticketId}`);
    const spec = this.stageMachine.createSpec({ ticketId, title });
    const saved = await this.store.write(path, spec);
    this.events.emit({ type: 'spec.created', repoId, spec: saved });
    return saved;
  }

  /* ---- prompts ---- */

  /** Render the stage prompt, feeding the approved upstream artifact as context. */
  async getStagePrompt(repoId: string, ticketId: string, stageId: StageId): Promise<ResolvedTemplate> {
    const path = await this.repoPath(repoId);
    const spec = await this.requireSpec(path, ticketId);
    const upstream = await this.readUpstreamArtifact(path, spec, stageId);
    return this.templates.render(path, stageId, {
      ticketId: spec.ticketId,
      title: spec.title,
      upstreamArtifact: upstream,
    });
  }

  /** Gather repo signals and return a brief for the agent to draft curated templates. */
  async proposeRepoTemplates(repoId: string): Promise<RepoBrief> {
    const path = await this.repoPath(repoId);
    return this.templates.generateCuratedTemplate(path, 'spec');
  }

  /** Persist a single draft template written by the agent. */
  async writeRepoTemplate(repoId: string, stageId: StageId, content: string): Promise<void> {
    const path = await this.repoPath(repoId);
    await this.templates.writeRepoTemplate(path, stageId, content);
  }

  /** Mark a template as human-curated. */
  async markTemplateCurated(repoId: string, stageId: StageId): Promise<void> {
    const path = await this.repoPath(repoId);
    await this.templates.markTemplateCurated(path, stageId);
  }

  /** List all 8 stage templates with their source status. */
  async listTemplates(repoId: string): Promise<TemplateSummary[]> {
    const path = await this.repoPath(repoId);
    return this.templates.listTemplates(path);
  }

  /* ---- stage transitions (all go mutate -> persist -> emit) ---- */

  async recordAiOutput(
    repoId: string,
    ticketId: string,
    stageId: StageId,
    content: string
  ): Promise<SpecFile> {
    const path = await this.repoPath(repoId);
    const spec = await this.requireSpec(path, ticketId);
    const stageIndex = STAGE_IDS.indexOf(stageId);
    const artifactPath = await this.store.writeArtifact(
      path,
      ticketId,
      stageId,
      stageIndex,
      content
    );
    const next = this.stageMachine.recordAiOutput(spec, stageId, artifactPath);
    return this.persist(repoId, path, next);
  }

  async approve(repoId: string, ticketId: string, stageId: StageId): Promise<SpecFile> {
    const path = await this.repoPath(repoId);
    const spec = await this.requireSpec(path, ticketId);
    return this.persist(repoId, path, this.stageMachine.approve(spec, stageId));
  }

  async reject(repoId: string, ticketId: string, stageId: StageId, comment: string): Promise<SpecFile> {
    const path = await this.repoPath(repoId);
    const spec = await this.requireSpec(path, ticketId);
    return this.persist(repoId, path, this.stageMachine.reject(spec, stageId, comment));
  }

  /** Throws GateNotApprovedError if the current gate isn't approved. */
  async advance(repoId: string, ticketId: string, stageId: StageId): Promise<SpecFile> {
    const path = await this.repoPath(repoId);
    const spec = await this.requireSpec(path, ticketId);
    return this.persist(repoId, path, this.stageMachine.advance(spec, stageId));
  }

  /* ---- internals ---- */

  private async requireSpec(path: string, ticketId: string): Promise<SpecFile> {
    const spec = await this.store.read(path, ticketId);
    if (!spec) throw new Error(`Unknown spec: ${ticketId}`);
    return spec;
  }

  private async persist(repoId: string, path: string, spec: SpecFile): Promise<SpecFile> {
    const saved = await this.store.write(path, spec);
    this.events.emit({ type: 'spec.updated', repoId, spec: saved });
    return saved;
  }

  private async readUpstreamArtifact(
    path: string,
    spec: SpecFile,
    stageId: StageId
  ): Promise<string | undefined> {
    const index = STAGE_IDS.indexOf(stageId);
    if (index <= 0) return undefined;
    const prev = spec.stages[index - 1];
    if (!prev.artifactPath) return undefined;
    try {
      const { readFile } = await import('fs/promises');
      const { join } = await import('path');
      return await readFile(join(path, prev.artifactPath), 'utf-8');
    } catch (err) {
      logger.warn('Could not read upstream artifact', prev.artifactPath, String(err));
      return undefined;
    }
  }
}
