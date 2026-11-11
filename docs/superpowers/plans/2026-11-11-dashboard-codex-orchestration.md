# Dashboard-driven Codex implementation plan

**Goal:** Create and continue ticket-specific local Codex runs from Dashboard decisions, without agent-side approval polling.

**Architecture:** AppCore remains the authority for artifacts, approvals and checks. Persist an opt-in automation job inside each ticket transaction, reconcile jobs after restart, and run one bounded Codex turn at a time in an isolated Git worktree. Review completion and execution completion are separate states.

**Execution:** Implement inline on `feat/dashboard-codex-orchestration`; the user authorized implementation on this branch. Use test-first changes for gates, scheduling, transport and API integration.

## 1. Implementation review
- [x] Add per-subtask review tokens bound to plan revision, task attempt, source fingerprint and an immutable implementation report.
- [x] Reject DEVELOP advancement until all implemented subtasks have current human approvals. Preserve completed historical tickets without manufacturing new approval.
- [x] Expose submit/read/approve/revise/reject implementation review operations; revisions reset affected tasks and invalidate their reviews.
- [x] Test unreviewed completion, revision mismatch, source drift, rework and repeated completion.

Files: `src/core/schemas.ts`, `stage-machine.ts`, `app-core.ts`, `execution.ts`, `src/mcp/workflow-tools.ts`, `src/dashboard/workflow-routes.ts`, new review tests.

## 2. Durable scheduler and workspace
- [x] Persist enabled automation, job state, worktree, thread, attempt and run ID in the ticket JSON. A saved ready job is the durable queue; in-process events only wake reconciliation.
- [x] Claim work inside SpecStore transactions; fence completion by run ID. Hold a process-owned ticket runner lock through each turn and reconcile crash owners conservatively.
- [x] Create deterministic worktrees without switching the user's checkout; checks use the bound worktree while canonical artifacts remain in the registered repo.
- [x] Reconcile creation, decision, pause/resume and startup, deduplicate watcher events, serialize each ticket, and bound total concurrent runs. Retry failures only through an explicit Dashboard retry.
- [x] Test restart recovery, duplicate events, stale results, concurrent tickets and failed startup.

Files: new `src/automation/` modules/tests; `app-core.ts`, `schemas.ts`, `index.ts`.

## 3. Local Codex adapter
- [x] Verify App Server protocol using the installed binary's generated bindings.
- [x] Add bounded JSON-RPC stdio client, initialization, thread creation/resume, turn completion/error/interrupt, timeouts and process cleanup.
- [x] Run artifact turns read-only and implementation turns with write access only to their worktree. Deny native approval requests rather than treating workflow approval as command authorization.
- [x] Parse structured output and persist it through AppCore after validating the run token. Service owns plan registration, claims, implementation logging/completion, checks and advancement.
- [x] Disable inherited AI Pilot MCP access for managed runs; never give the model an approval capability.
- [x] Test with a protocol-compatible subprocess fixture, including malformed output and process exit.

Files: `src/automation/codex-client.ts`, `codex-runner.ts`, result schema and subprocess fixture tests.

## 4. Dashboard and documentation
- [x] Add explicit automatic execution selection at creation and enable/retry controls for existing tickets.
- [x] Show queue/run/error/thread/worktree and implementation review evidence in the existing detail page.
- [x] Keep approval endpoints separate from agent output and add browser-session/Origin protections for review writes; refuse managed work until its command permission policy is configured.
- [x] Update shared Specflow skill and README to explain managed single-turn execution, compatibility, checks and limits.
- [x] Verify backend/frontend tests, type checks, production build and relevant Playwright scenarios.

Files: `src/dashboard/server.ts`, new automation routes, `dashboard_frontend/src/`, `skills/specflow/SKILL.md`, `README.md`.

Verification commands use `/Users/I605217/.nvm/versions/node/v22.17.1/bin/node` for this machine. Full backend tests require loopback listening outside the filesystem sandbox. Live model execution is separate from subprocess/integration validation; do not claim VS Code plugin session attachment.

## Verification outcome

- Backend: 264 tests passed; frontend: 19 tests passed; both TypeScript checks passed.
- Production build and four skill installer tests passed.
- Three Playwright browser scenarios passed, including implementation revision and approval before TEST.
- Native Codex App Server initialization and process cleanup passed with the installed VS Code bundled binary, without starting a model turn.
- Independent review findings addressed with regression tests: canonical check command authority, scheduler state-version fencing, descendant process cleanup, and retained-check-lock retry refusal.
- Real model execution and native VS Code plugin thread visibility remain unverified; the adapter manages App Server threads directly.
