import { promises as fs } from 'fs';
import { join } from 'path';
import { STAGE_IDS, type StageId } from '../core/schemas.js';

/**
 * Resolves the prompt template for a stage. Per the AI-Assisted Development
 * Blueprint, "the content of the prompts should be yours" — so a repo-curated
 * template is the PRIMARY source. We fall back to a generic blueprint default
 * (full of [placeholder]s) only when the repo hasn't been curated yet.
 *
 * Resolution order:
 *   1. <repo>/.specflow/templates/{stage}.md   (curated, per-repo)
 *   2. baked-in blueprint default               (generic, placeholders)
 *
 * A future sub-agent generator will inspect a repo and WRITE path #1; this
 * resolver is the read seam it plugs into. See generateCuratedTemplate below.
 */

export interface ResolvedTemplate {
  stageId: StageId;
  content: string;
  source: 'repo' | 'blueprint-default';
}

export class PromptTemplates {
  private repoTemplatePath(repoPath: string, stageId: StageId): string {
    return join(repoPath, '.specflow', 'templates', `${stageId}.md`);
  }

  async resolve(repoPath: string, stageId: StageId): Promise<ResolvedTemplate> {
    const curated = await fs
      .readFile(this.repoTemplatePath(repoPath, stageId), 'utf-8')
      .catch(() => null);
    if (curated !== null) {
      return { stageId, content: curated, source: 'repo' };
    }
    return {
      stageId,
      content: BLUEPRINT_DEFAULTS[stageId],
      source: 'blueprint-default',
    };
  }

  /**
   * Render a stage prompt, interpolating known context (the ticket, the title,
   * and any approved upstream artifact). Interpolation is intentionally simple:
   * {{ticketId}}, {{title}}, {{upstreamArtifact}}.
   */
  async render(
    repoPath: string,
    stageId: StageId,
    vars: { ticketId: string; title: string; upstreamArtifact?: string }
  ): Promise<ResolvedTemplate> {
    const base = await this.resolve(repoPath, stageId);
    const content = base.content
      .replaceAll('{{ticketId}}', vars.ticketId)
      .replaceAll('{{title}}', vars.title)
      .replaceAll('{{upstreamArtifact}}', vars.upstreamArtifact ?? '');
    return { ...base, content };
  }

  /**
   * SEAM (not implemented in v1): a sub-agent inspects the repo (CLAUDE.md,
   * build files, test framework, example classes) and fills the blueprint
   * placeholders to produce a curated per-repo template, which a human then
   * reviews before it becomes the resolved source.
   */
  async generateCuratedTemplate(_repoPath: string, _stageId: StageId): Promise<never> {
    throw new Error(
      'Sub-agent template generation is not implemented in v1. ' +
        'Curate .specflow/templates/{stage}.md by hand for now.'
    );
  }
}

/** Lint helper: every stage must have a default. */
export function assertAllDefaultsPresent(): void {
  for (const id of STAGE_IDS) {
    if (!BLUEPRINT_DEFAULTS[id]) throw new Error(`Missing blueprint default for stage: ${id}`);
  }
}

/**
 * Generic blueprint-derived defaults, lifted from the AI-Assisted Development
 * Blueprint (Part 2). Placeholders are deliberate: a team curates them per repo.
 * Stage 0 (spec) and Stage 1 (requirements) are first-class (full content);
 * stages 2-7 are lighter stubs that still carry the human gate + governance.
 */
const BLUEPRINT_DEFAULTS: Record<StageId, string> = {
  spec: `# Stage 0 — Spec: {{ticketId}} {{title}}

You are drafting the AI-consumable spec that Claude reads as its primary context
for every development session on this ticket. Write it to \`specs/{{ticketId}}-<feature-name>.md\`.

The spec MUST include:
- **Acceptance criteria** in Given/When/Then form.
- **Affected file paths** (concrete, from this repo).
- **Interface contracts** (signatures, request/response shapes).
- **Step-by-step logic** with explicit conditionals.
- **Per-exception error handling** (what to do for each failure).
- **Test framework and file locations** (where tests live in this repo).
- **Definition of Done.**
- A **Conventions to Follow** section pointing at the repo's CLAUDE.md memory
  files and reference implementations.

Human gate: an engineer completes the spec and passes the pre-handoff checklist
before any development begins. The spec is the contract — incomplete specs
produce incomplete or incorrect code.
`,

  requirements: `# Stage 1 — Requirements & Story Refinement: {{ticketId}} {{title}}

Analyze this business requirement for our [describe your system/area]:
{{upstreamArtifact}}

Identify:
1. Which parts of the system are affected.
2. Any existing functionality we can reuse.
3. What needs to be built from scratch.
4. Any data migration requirements.
5. Integration touchpoints with [list your team's downstream systems].

Format as a structured analysis.

Adapt: describe your system in the terms your team uses.

Human gate: Product Owner approves acceptance criteria; Architect confirms
impact on affected areas.
`,

  design: `# Stage 2 — Architecture & Design: {{ticketId}} {{title}}

Design a new [component/module/service] for [capability].
Follow our conventions:
- [describe your layering/structural pattern, e.g. service/facade/DAO]
- [describe your configuration approach]
- [describe any data model change requirements]
Output the component structure and key interface definitions.

Adapt: paste an example class or interface from your repo as a reference point.

Human gate: team architect reviews the design artifact. Engage security sign-off
if the design needs a security review.
`,

  develop: `# Stage 3 — Development: {{ticketId}} {{title}}

Implement [ClassName/component] for [business logic description].
Use our existing patterns: [paste a relevant class or snippet from your repo].
Wire up these dependencies: [list].
Handle these error cases: [list from acceptance criteria].

Developer rules:
- Review every line of generated code before committing.
- Add \`// AI-assisted\` on files where >50% is AI-generated (metrics).
- Run the local build and tests before pushing.
- Claude Code never pushes — developers commit and push.
`,

  test: `# Stage 4 — Testing: {{ticketId}} {{title}}

Write comprehensive unit tests for [ClassName]. Use [your mocking library].
Cover: happy path, null inputs, boundary values, error paths.
Follow our test naming convention: [describe]. Target 80% line coverage on new code.

Adapt: specify your test base class, framework (JUnit/TestNG/Jest/pytest), and
shared test infrastructure.

Coverage gates: unit 80% line (CI report), integration = all public service
methods, API tests = all new endpoints, E2E = all acceptance-criteria scenarios.
`,

  build: `# Stage 5 — Build & CI: {{ticketId}} {{title}}

Diagnose this build failure: [paste build log].
Identify root cause, affected component, and the required fix.
Distinguish between compilation errors, configuration errors, and test failures.

Adapt: mention your build tool (Maven/Gradle/npm) and CI platform
(Jenkins/GitHub Actions/Concourse/Azure Pipelines).
`,

  deploy: `# Stage 6 — Deployment: {{ticketId}} {{title}}

Generate a deployment checklist for releasing [feature/version] to [environment].
Based on these changes: [list changed components and migration scripts].
Include: pre-deployment checks, deployment steps, post-deployment validation,
rollback trigger criteria, estimated downtime window.

PCI/GDPR controls (mandatory): No customer PII in deployment scripts. Payment
changes require Security review. Data migrations touching customer or order data
require DPO notification if GDPR-scoped.
`,

  ops: `# Stage 7 — Production Operations: {{ticketId}} {{title}}

Analyze these production logs for errors: [paste sanitized log excerpt].
Identify: error type, affected component, root cause hypothesis, suggested
investigation steps.

CRITICAL RULE: Never paste raw production data. Sanitize logs first — remove
email addresses, customer IDs, order numbers, and any PAN/card data. Use
[REDACTED] placeholders.
`,
};
