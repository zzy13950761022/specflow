import type { StageId } from '../core/schemas.js';

export type BlueprintDefaults = Record<StageId, string>;

/**
 * Generic blueprint-derived defaults, lifted from the AI-Assisted Development
 * Blueprint (Part 2). Placeholders are deliberate: a team curates them per repo.
 * Stage 0 (spec) and Stage 1 (requirements) are first-class (full content);
 * stages 2-7 are lighter stubs that still carry the human gate + governance.
 */
export const BLUEPRINT_DEFAULTS: BlueprintDefaults = {
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

Based on the approved design:
{{upstreamArtifact}}

## Phase A — Task Planning (submit via record_ai_output, then wait for approval)

Generate a structured implementation task list. Use set_develop_subtasks to register
each task. For each subtask include:
- description: what to build
- prompt: role, task detail, restrictions, success criteria
- requirementRef: which requirement it implements
- leverage: existing files/utilities to reuse

Submit a markdown summary of the task list via record_ai_output. Human reviews
and approves the plan before any code is written.

## Phase B — Implementation (after gate approved)

For each subtask, in order:
1. Search existing implementation logs via get_implementation_logs to avoid duplication.
2. Read the subtask prompt field for role and guidance.
3. Write the code using Write/Edit tools — follow repo conventions from CLAUDE.md.
4. Call log_implementation with full artifacts (MANDATORY before marking done):
   - summary, filesModified, filesCreated, statistics
   - artifacts: apiEndpoints / components / functions / classes / integrations
5. Call toggle_subtask to mark the subtask completed.
6. Move to the next subtask.

Developer rules:
- Review every line of generated code before committing.
- Add \`// AI-assisted\` on files where >50% is AI-generated.
- Run the local build and tests before pushing.
- Never push — developers commit and push.
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
