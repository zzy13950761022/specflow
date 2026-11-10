# Workflow Evolution Implementation Plan

> For agentic workers: execute sequentially in the current session using executing-plans; the six increments share schema and state-machine dependencies. Use requesting-code-review for final independent review.

**Goal:** Deliver the six prioritized workflow improvements specified in the accompanying spec.

**Architecture:** Keep AppCore as the mutation boundary and StageMachine as the pure domain layer. Add execution evidence and context builders as focused modules; all transports share the same domain contracts.

**Tech Stack:** TypeScript, Zod, Node fs/child_process, Fastify/MCP, React, Vitest, Playwright.

## Task 1 — Rework and invalidation

Files: src/core/schemas.ts, src/core/stage-machine.ts, src/core/app-core.ts, src/core/workflow.test.ts.

- [x] Add tests for DESIGN reopening from TEST, invalid reasons/targets, preserved artifact history.
- [x] Run `npx vitest run src/core/workflow.test.ts`; expect missing reopen behavior.
- [x] Add stage revision/stale metadata and reworkHistory; implement reopen and conservative downstream invalidation.
- [x] Verify target resubmission clears stale and downstream approvals remain invalid.

## Task 2 — State constraints and transactions

Files: same domain files, src/core/spec-store.ts, existing core/transport tests.

- [x] Add tests for out-of-order submissions, stale approvals, plan changes, log-gated completion, duplicate advance, concurrent mutations.
- [x] Run focused tests and confirm failure before implementing constraints.
- [x] Add active stage and approvedRevision, explicit transition guards and idempotent completion.
- [x] Put read/mutate/write under a disk-backed ticket transaction and retain atomic file replacement.
- [x] Adjust legacy fixtures to enter stages legitimately; migrate older schemas conservatively.
- [x] Run core and storage suites.

## Task 3 — Execution evidence

Files: src/core/check-runner.ts, src/core/check-runner.test.ts, domain integration.

- [x] Add failing tests using Node fixture commands: success, failure, timeout, stale report, code drift.
- [x] Implement configured argv execution, output/report capture, repository fingerprint and bounds.
- [x] Persist platform-issued evidence and require it for TEST/BUILD approval and advance.
- [x] Verify AI metrics alone never satisfy the gate and source changes invalidate evidence.

## Task 4 — Context and traceability

Files: src/core/stage-context.ts, src/core/stage-context.test.ts, src/core/app-core.ts.

- [x] Add failing tests for combined TEST context, stale inputs, missing files and requirement links.
- [x] Build approved upstream context and current-version implementation logs.
- [x] Append context to rendered prompts and expose structured context/traceability.
- [x] Preserve curated template rendering and run prompt/core tests.

## Task 5 — Workflow templates and policies

Files: src/core/workflow-policy.ts, workflow tests, schema and state-machine integration.

- [x] Add failing tests for standard/bugfix/documentation and low/high risk policy behavior.
- [x] Define fixed participation maps and skipped reasons; advance through participating stages.
- [x] Auto-approve only opted-in low-risk TEST/BUILD after evidence validation, with policy actor audit.
- [x] Verify default remains manual and protected decisions require human approval.

## Task 6 — Recovery and task dependencies

Files: src/core/execution.ts, workflow tests, state-machine and AppCore integration.

- [x] Add failing tests for pause/resume, interrupted checks, final completion, dependency cycles, conflicting claims and idempotent completion.
- [x] Derive structured next actions from execution/stage state; persist retries and interruption recovery.
- [x] Add stable task IDs/dependencies/files, claim/release and completion with dependency invalidation.
- [x] Replace approval wait with bounded subscription and post-subscription reread.
- [x] Verify ready independent tasks can be claimed concurrently and integration gates stay required.

## Task 7 — Transport and Dashboard integration

Files: src/mcp/server.ts, src/dashboard/server.ts, dashboard_frontend/src/types.ts, api.ts and components.

- [x] Add MCP/REST contract tests before adding tools/endpoints.
- [x] Expose reopen, checks, context, traceability, execution and task scheduling via shared AppCore.
- [x] Render stale/skipped/revision/evidence/execution states; add rework and pause/resume controls and workflow creation fields.
- [x] Send expectedRevision with approval and surface errors in task controls.
- [x] Update tool enumeration tests, bounded polling tests, canonical artifact path tests.

## Task 8 — Verification and documentation

- [x] Run `npm test`, `npm run test:frontend`, `npx tsc --noEmit`, `npx tsc -p dashboard_frontend/tsconfig.json`, `npm run build`, `npm run test:e2e`.
- [x] Request independent spec review followed by code-quality review, fix actionable findings.
- [x] Update README and mark verified priorities complete in spec. Leave changes reviewable in the existing feature branch.

## Verified delivery

All six increments and transport integration are implemented. Initial verification:
223 backend tests, 17 frontend tests, both TypeScript checks, production build and
one Playwright workflow test passed. Independent spec and code-quality reviews
were completed; actionable findings were fixed with regressions. Browser screenshot
was inspected at `/private/tmp/ai-pilot-workflow-e2e.png`.

After the legacy-completion and DEVELOP/Maven fixes, local-organization checks
passed on 2026-11-10: 242 backend tests, 19 frontend tests and one Playwright
workflow test. The installed skill's four Python tests and the synchronization
tool's 13 Git integration tests also passed.

Changes are maintained in the existing `ai_pilot_feature` branch and organized
into local commits by workflow, shared skill and synchronization tooling. No
remote merge, push or deployment is included in this preparation. See the spec
and README for check configuration, migration and fingerprint limitations.
