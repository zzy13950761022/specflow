# Dashboard agent workflow implementation plan

> For agentic workers: use superpowers:subagent-driven-development for bounded implementation and review tasks.

**Goal:** Create and find tickets in Dashboard, configure personal Hyperspace-backed agents, continue after human decisions, and hand work to/from an IDE.

**Architecture:** Start from exploration commit 8d58188 in an isolated worktree. Keep canonical state, versioned reviews and real check evidence in AppCore. Add user-local named profiles, native agent adapters and explicit ownership handoff; preserve the registered checkout and ticket worktree.

**Tech stack:** TypeScript, Fastify, Zod, React, native Codex JSON-RPC and Claude/OpenCode headless interfaces, Vitest and Playwright.

## Contracts

`AgentProfile = { id, name, agent: 'codex'|'claude'|'opencode', version: number, command?: string, configPath?: string, provider?: string, model?: string, baseUrl?: string, credentialEnv?: string }`. Credentials are environment references, never values.

`AgentSettings = { revision: number, profiles: AgentProfile[], defaultProfileId?: string, repoDefaults: Record<string,string> }`. Save requires the loaded revision. Profile version is assigned by the backend.

HTTP contracts:
- GET/PUT `/api/agents/settings`: load/save AgentSettings.
- POST `/api/agents/detect`: `{agent,command?,configPath?}` -> `{available,version?,configPath?,provider?,model?,baseUrl?,credentialEnv?,error?}`.
- POST `/api/agents/test`: `{profile}` -> `{ok,checks:[{name,status:'passed'|'failed'|'skipped',message}]}`. Executes one read-only no-tool model request in a temporary workspace.
- POST existing `/api/repos/:repoId/specs`: adds `description?` and `agentProfileId?` alongside `autoRun`; returns SpecFile even when later launch fails.
- POST existing ticket `/automation`: accepts `{enabled,profileId?}`; snapshots a selected profile, retains it on ordinary retries.
- GET ticket `/handoff`: `{context,workspacePath,mode:'dashboard'|'ide',canHandoff,reason?}`; has no mutations.
- POST ticket `/handoff`: cancels managed execution, waits until stopped, transfers to IDE, then returns the context.
- POST ticket `/automation/resume`: `{profileId?}`; checks no live task/check claims before transferring back and enabling automation.

All sensitive settings, diagnostics and ownership endpoints use Dashboard review-session authentication. Native session IDs are never portable between agents. Settings changes do not silently change an existing ticket.

## Task 1: UI surface

Files: `dashboard_frontend/src/components/{NewSpec,AgentSettingsDialog,Dialog,IdeHandoff,WorkflowControls,Header}.tsx`, `pages/{BoardPage,SpecDetailPage}.tsx`, `lib/board.ts`, `api.ts`, frontend tests and `e2e/happy-path.spec.ts`.

- [x] Add meaningful filter tests: case-insensitive ticket/title search, workflow/stage/status combinations, deterministic updated/created/ticket sorting. Run `npm run test:frontend` and observe missing behavior before implementing.
- [x] Implement accessible dialog with title, focus containment/restore, Escape, labels and retained error input. Move the create fields into it; add description, repository and agent selection. Navigate to the created ticket once persisted.
- [x] Replace the row with URL-backed filters, counts and separate empty states. Preserve the list URL on detail navigation/back.
- [x] Add Settings next to Add repo: named profiles, user/repo defaults, native detection, model overrides, environment credential reference and connection test.
- [x] Add stage-top context copy, explicit IDE handoff and Dashboard resume. Display generic agent execution status/profile/session. Update browser flows for modal creation.

## Task 2: Configuration and runtimes

Files: `src/core/agent-profile.ts`, `src/automation/{agent-settings,agent-detection,agent-adapters,headless-client}.ts` and focused tests.

- [x] Test settings atomic save, stale revision rejection, invalid defaults/duplicates, profile snapshot stability and no credential values before implementation.
- [x] Implement restrictive settings schemas and user-local persistence. Read selected native model transport configuration only. Preserve per-agent protocols and model IDs.
- [x] Check installed CLI help before implementing native invocation. Codex reuses App Server; Claude uses print/structured output/resume; OpenCode uses standalone JSON output and session resume. All subprocesses use argv, bounded output, timeout and cancellation.
- [x] Add subprocess fixtures covering session IDs, resume, malformed/error output, structured results, cancellation and denied permission requests. Never treat fixtures as real Hyperspace validation.

## Task 3: Integration and handoff

Files: `src/core/{app-core,schemas,stage-machine}.ts`, `src/automation/{codex-runner,orchestrator}.ts`, `src/dashboard/{agent-routes,workflow-routes,review-session,server}.ts`, `src/index.ts`, `skills/specflow/SKILL.md`.

- [x] Add tests for creation description/profile snapshot; run before changes. Create+queue must be one canonical transaction.
- [x] Dispatch native adapters through the existing host-owned execution path; include descriptions and approved context. Keep human review and platform check operations host-owned.
- [x] Test copy is read-only, handoff cannot release live processes/checks, late output is rejected, and resume blocks live external task claims.
- [x] Implement explicit IDE ownership handoff with cancellation/wait and context generated from current canonical state. Resume rechecks source/check state and starts a new native session after IDE work. Update skill for canonical repo plus worktree context.
- [x] Start scheduler with Dashboard by default, with explicit opt-out; tasks still require user-selected automation. Protect configuration/ownership endpoints with browser session.

## Task 4: Validation and delivery

- [x] Run build, backend tests and frontend tests with Node 22. Run Playwright against isolated fixture repositories; inspect screenshots of Board, Create and Settings.
- [x] Review specification coverage, then code quality; address material findings and rerun affected checks.
- [x] Document startup, configuration, Hyperspace compatibility checks, handoff and limitations. Record actual validation evidence and retain main unchanged.

## Baseline evidence

2026-11-11: build passed; 26 backend files / 268 tests passed with Node 22.17.1. Homebrew Node 25 fails before startup due to missing libsimdjson.30.dylib. Native Claude/OpenCode help was inspected without starting model execution.

## Final validation evidence

2026-11-11, Node 22.17.1, feature worktree `/private/tmp/ai-pilot-dashboard-agents`:

- `npm run build`: passed (TypeScript backend and Vite Dashboard).
- `npm test`: 33 files / 287 tests passed.
- `npm run test:frontend`: 3 files / 28 tests passed.
- `npx tsc --noEmit -p dashboard_frontend/tsconfig.json`: passed.
- `npm run test:e2e`: 11 browser tests passed.
- `git diff --check`: passed.
- Spec coverage and final code review passed after correcting provider/model
  mismatch handling, ticket profile snapshot preservation, Agent-specific native
  configuration checks and board status filtering. Dialog screenshots inspected;
  fields scroll inside the body while the footer remains fixed.

Minimal real model connection checks passed for Codex, Claude Code and OpenCode
using native local configuration. The Homebrew Codex executable was broken; the
installed VS Code extension binary worked (0.167.0-alpha.4.1). Claude Code was
2.1.116 and OpenCode 2.2.5. Full ticket workflows use simulated subprocess fixtures
plus actual host worktrees/check commands; these are not full real-model end-to-end
programming runs. Configuration values and credentials were not committed.

The original checkout remains on main at `0b735b4`, with its pre-existing
untracked content preserved. Feature work is retained separately; no merge or
push is performed.
