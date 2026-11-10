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

You are drafting the AI-consumable spec that the AI assistant reads as its primary context
for every development session on this ticket. Write it to \`.specflow/specs/{{ticketId}}-<feature-name>.md\`.

The spec MUST include:
- **Acceptance criteria** in Given/When/Then form, with stable IDs. Supply acceptanceCriteria (id/given/when/then) when calling record_ai_output.
- **Affected file paths** (concrete, from this repo).
- **Interface contracts** (signatures, request/response shapes).
- **Step-by-step logic** with explicit conditionals.
- **Per-exception error handling** (what to do for each failure).
- **Test framework and file locations** (where tests live in this repo).
- **Definition of Done.**
- A **Conventions to Follow** section pointing at the repo's AGENTS.md instructions (fall back to CLAUDE.md for legacy repos)
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

Adapt: describe your system in the terms your team uses.

## How to record this stage

Call record_ai_output with BOTH a markdown \`content\` summary AND the structured
\`requirementsData\` object below — the dashboard renders \`requirementsData\` as a
file tree-table plus a four-quadrant grid, and keeps \`content\` as a readable
fallback.

\`requirementsData\` shape:
- **affectedFiles**: a FLAT list of the files this work touches (item 1 above).
  Each entry is \`{ path, impact? }\` where \`path\` is the full repo-relative path
  (e.g. 'src/app/shared/provider/Foo.ts') and \`impact\` is a short note on what
  changes and why. Do NOT build a tree — just list files; the dashboard groups
  them into a collapsible directory tree for you.
- **reuse**: existing functionality to reuse (item 2) — array of \`{ title, detail? }\`.
- **buildFromScratch**: what must be built new (item 3) — array of \`{ title, detail? }\`.
- **dataMigration**: data migration requirements (item 4) — array of \`{ title, detail? }\`.
- **integrations**: integration touchpoints (item 5) — array of \`{ title, detail? }\`.

Example:
\`\`\`json
{
  "affectedFiles": [
    { "path": "src/core/order.ts", "impact": "Add discount field to Order" },
    { "path": "src/api/checkout.ts", "impact": "New POST /checkout/apply-discount" }
  ],
  "reuse": [{ "title": "PricingService", "detail": "Reuse existing tax calc pipeline" }],
  "buildFromScratch": [{ "title": "DiscountRule engine", "detail": "New rule evaluation" }],
  "dataMigration": [{ "title": "Backfill order.discount = 0 for existing rows" }],
  "integrations": [{ "title": "Billing service", "detail": "Emit discount-applied event" }]
}
\`\`\`

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
- id: stable task identifier
- dependsOn: task IDs this task requires; files: planned modified paths
- testRefs: test files or test case identifiers covering the linked requirement

Submit a markdown summary of the task list via record_ai_output. Human reviews
and approves the plan before any code is written.

## Phase B — Implementation (after gate approved)

Read get_next_actions. Claim ready subtasks with claim_subtask; independently claimed tasks with nonconflicting files may run concurrently. For each claimed task:
1. Search existing implementation logs via get_implementation_logs to avoid duplication.
2. Read the subtask prompt field for role and guidance.
3. Write the code using the current client’s file-editing tools — follow AGENTS.md (or legacy CLAUDE.md).
4. Call log_implementation with the returned claimId and full artifacts (MANDATORY before marking done):
   - summary, filesModified, filesCreated, statistics
   - artifacts: apiEndpoints / components / functions / classes / integrations
5. Call set_subtask_completed with completed=true and the same claimId. This operation is idempotent.
6. Move to the next subtask.

Developer rules:
- Review every line of generated code before committing.
- Add \`// AI-assisted\` on files where >50% is AI-generated.
- Run the local build and tests before pushing.
- Never push — developers commit and push.
`,

  test: `# Stage 4 — Testing: {{ticketId}} {{title}}

Use the approved stage context and implementation logs to implement tests for every acceptance criterion. Cover happy paths, boundaries and error handling using {{testFramework}}.

Execute run_stage_check with stageId=test. The platform runs the command in .specflow/checks.json, records its exit code and output, and reads actual Istanbul line coverage from the configured report. A passing exit code and at least 80% measured coverage are required. Never estimate coverage or use AI-supplied metrics as evidence.

Record the result summary with record_ai_output, including references to the platform run and relevant test cases. Use get_traceability to identify criteria missing implementation or tests. Then call get_approval_status (waitMs up to 60000); act on its structured actions. If tests expose a design or implementation defect, use reopen_stage with the earliest affected stage and a concrete reason, then redo invalidated downstream work.
`,

  build: `# Stage 5 — Build & CI: {{ticketId}} {{title}}

Execute run_stage_check with stageId=build. The platform runs the configured argv from .specflow/checks.json and records actual output, exit code and code fingerprint. AI metrics alone do not satisfy the gate. Fix compilation/configuration issues before submitting; source changes require revalidating TEST first.

Record the build summary using record_ai_output and reference its platform run. Call get_approval_status and follow structured actions; an opted-in low-risk check policy may approve passing checks. Human release approval remains mandatory.
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
