import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { STAGE_IDS, type StageId } from '../core/schemas.js';
import { BLUEPRINT_DEFAULTS } from './template-defaults.js';
import { introspectRepo, type RepoBrief, type BuildTool } from '../core/repo-introspector.js';

export { BLUEPRINT_DEFAULTS } from './template-defaults.js';

/**
 * Resolves the prompt template for a stage. Per the AI-Assisted Development
 * Blueprint, "the content of the prompts should be yours" — so a repo-curated
 * template is the PRIMARY source. We fall back to a repo-draft (written but not
 * yet curated by a human), and finally to the generic blueprint default.
 *
 * Resolution order:
 *   1. <repo>/.specflow/templates/{stage}.md + meta.curated=true  → 'repo-curated'
 *   2. <repo>/.specflow/templates/{stage}.md (no meta or curated=false) → 'repo-draft'
 *   3. baked-in blueprint default                                  → 'blueprint-default'
 */

export type TemplateSource = 'repo-curated' | 'repo-draft' | 'blueprint-default';

export interface ResolvedTemplate {
  stageId: StageId;
  content: string;
  source: TemplateSource;
}

export interface TemplateSummary {
  stageId: StageId;
  source: TemplateSource;
  content: string;
}

interface TemplateMeta {
  curated: boolean;
}

const TEST_COMMANDS: Record<BuildTool, string> = {
  maven: 'mvn clean test --no-transfer-progress 2>&1 | tail -60',
  gradle: './gradlew test 2>&1 | tail -60',
  npm: 'npm test 2>&1 | tail -60',
  python: 'pytest -v 2>&1 | tail -60',
  unknown: '<run your test suite here>',
};

const BUILD_COMMANDS: Record<BuildTool, string> = {
  maven: 'mvn clean install --no-transfer-progress 2>&1 | tail -60',
  gradle: './gradlew build 2>&1 | tail -60',
  npm: 'npm run build 2>&1 | tail -60',
  python: 'python -m build 2>&1 | tail -60',
  unknown: '<run your build command here>',
};

const TEST_FRAMEWORKS: Record<BuildTool, string> = {
  maven: 'JUnit / Spock (Groovy)',
  gradle: 'JUnit / Kotest',
  npm: 'Jest / Vitest',
  python: 'pytest',
  unknown: 'your test framework',
};

export class PromptTemplates {
  private repoTemplatePath(repoPath: string, stageId: StageId): string {
    return join(repoPath, '.specflow', 'templates', `${stageId}.md`);
  }

  private repoTemplateMetaPath(repoPath: string, stageId: StageId): string {
    return join(repoPath, '.specflow', 'templates', `${stageId}.meta.json`);
  }

  private async readMeta(repoPath: string, stageId: StageId): Promise<TemplateMeta | null> {
    const raw = await fs.readFile(this.repoTemplateMetaPath(repoPath, stageId), 'utf-8').catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TemplateMeta;
    } catch {
      return null;
    }
  }

  async resolve(repoPath: string, stageId: StageId): Promise<ResolvedTemplate> {
    const templateContent = await fs
      .readFile(this.repoTemplatePath(repoPath, stageId), 'utf-8')
      .catch(() => null);

    if (templateContent !== null) {
      const meta = await this.readMeta(repoPath, stageId);
      const source: TemplateSource = meta?.curated ? 'repo-curated' : 'repo-draft';
      return { stageId, content: templateContent, source };
    }

    return {
      stageId,
      content: BLUEPRINT_DEFAULTS[stageId],
      source: 'blueprint-default',
    };
  }

  /**
   * Render a stage prompt, interpolating known context (the ticket, the title,
   * and any approved upstream artifact). Supports {{ticketId}}, {{title}},
   * {{upstreamArtifact}}, {{testCommand}}, {{buildCommand}}, {{testFramework}}.
   * The build-tool-specific placeholders are resolved by introspecting the repo.
   */
  async render(
    repoPath: string,
    stageId: StageId,
    vars: { ticketId: string; title: string; upstreamArtifact?: string }
  ): Promise<ResolvedTemplate> {
    const [base, brief] = await Promise.all([
      this.resolve(repoPath, stageId),
      introspectRepo(repoPath),
    ]);
    const content = base.content
      .replaceAll('{{ticketId}}', vars.ticketId)
      .replaceAll('{{title}}', vars.title)
      .replaceAll('{{upstreamArtifact}}', vars.upstreamArtifact ?? '')
      .replaceAll('{{testCommand}}', TEST_COMMANDS[brief.buildTool])
      .replaceAll('{{buildCommand}}', BUILD_COMMANDS[brief.buildTool])
      .replaceAll('{{testFramework}}', TEST_FRAMEWORKS[brief.buildTool]);
    return { ...base, content };
  }

  /**
   * Persist a draft template to <repo>/.specflow/templates/{stage}.md.
   * Does NOT mark it curated — a human must call markTemplateCurated afterward.
   */
  async writeRepoTemplate(repoPath: string, stageId: StageId, content: string): Promise<void> {
    const path = this.repoTemplatePath(repoPath, stageId);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, content, 'utf-8');
  }

  /**
   * Mark a repo template as human-curated by writing a sidecar meta file.
   * Once curated, resolve() returns source='repo-curated'.
   */
  async markTemplateCurated(repoPath: string, stageId: StageId): Promise<void> {
    const metaPath = this.repoTemplateMetaPath(repoPath, stageId);
    await fs.mkdir(dirname(metaPath), { recursive: true });
    const meta: TemplateMeta = { curated: true };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }

  /**
   * List all 8 stage templates for a repo, with their current source status.
   */
  async listTemplates(repoPath: string): Promise<TemplateSummary[]> {
    return Promise.all(
      STAGE_IDS.map(async (stageId) => {
        const resolved = await this.resolve(repoPath, stageId);
        return { stageId, source: resolved.source, content: resolved.content };
      })
    );
  }

  /**
   * Inspect the repo and return a generation brief. A Claude agent (the caller)
   * uses this brief to draft curated templates, then calls writeRepoTemplate for
   * each stage. The Node process never calls an LLM directly.
   */
  async generateCuratedTemplate(repoPath: string, _stageId: StageId): Promise<RepoBrief> {
    return introspectRepo(repoPath);
  }
}

/** Lint helper: every stage must have a default. */
export function assertAllDefaultsPresent(): void {
  for (const id of STAGE_IDS) {
    if (!BLUEPRINT_DEFAULTS[id]) throw new Error(`Missing blueprint default for stage: ${id}`);
  }
}
