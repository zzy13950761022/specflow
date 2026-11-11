# Agent settings usability implementation plan

> For agentic workers: use superpowers:subagent-driven-development for the bounded discovery task and review. User approved implementation.

**Goal:** Configure execution by selecting Agent and model without typing internal identifiers or a redundant name.

**Architecture:** Extend read-only native detection with verified executable candidates and locally configured model choices. Keep persisted profiles and ticket snapshots unchanged. Default to native settings; put optional overrides in advanced settings.

**Tech Stack:** TypeScript, React, Fastify, Vitest and Playwright.

## Contract

Extend POST /api/agents/detect with command?: string, installations?: Array<{command:string,label:string,version:string}>, models?: Array<{id:string,label:string,provider?:string}>. Choices come from local configuration, not an authorization claim. No credentials are returned. Explicit broken commands report errors; absent command probes PATH then bounded conventional installations, including Codex VS Code bundles. Tests and profile pinning must use the resolved command.

## Task 1: Native discovery

Files: src/automation/agent-detection.ts, agent-discovery.ts if useful, their tests, src/dashboard/agent-routes.ts.

- [x] Write failing tests for broken PATH fallback, explicit bad command, local model/provider choices and secret omission.
- [x] Implement bounded executable discovery and native model listing. Resolve commands for connection tests and pinned profiles. No remote catalog calls.
- [x] Run focused Vitest tests with Node 22 and obtain spec/code review.

## Task 2: Settings and selection UI

Files: AgentSettingsDialog.tsx, NewSpec.tsx, WorkflowControls.tsx, lib/agent-profiles.ts, api.ts, types.ts, e2e/happy-path.spec.ts.

- [x] Write failing tests for automatic names, custom-name preservation, clearing incompatible transport, automatic detection and advanced controls.
- [x] Default names to AGENT_LABELS[agent]. Show Agent and model first. Hide name and transport/path overrides in Advanced settings. Preserve custom names.
- [x] Automatically detect on selection and path changes; fence stale requests and retain saved overrides. Dropdown offers local current model, locally declared choices, Custom model, and search. Program choices use verified candidates.
- [x] Shared label shows custom name when present, otherwise Agent plus model or Local current model. Rename Agent profile to Execution configuration in create and resume (retain English UI).
- [x] Browser regressions cover conflicts, detection errors, collapsed controls, fallback program, Agent change and existing ticket snapshots.

## Task 3: Verification and delivery

- [x] Build, backend/frontend tests, frontend TypeScript, complete Playwright suite; inspect collapsed/advanced screenshots.
- [x] Review final diff, address findings, update README and validation record.
- [x] Keep existing isolated worktree, commit locally after verification, preserve original main.

Node runtime: /Users/I605217/.nvm/versions/node/v22.17.1/bin. Baseline f7c7b6a was clean; previous validation passed 287 backend, 28 frontend and 11 browser tests.


## Validation record

2026-11-11, Node 22.17.1:

- Build passed, including backend TypeScript and production Dashboard assets.
- Backend: 34 test files / 299 tests passed.
- Frontend: 4 test files / 32 tests passed; frontend TypeScript passed.
- Browser: 13 tests passed; screenshot capture rerun after detection settled.
- Collapsed and advanced settings screenshots inspected; scroll body and fixed footer remain separate.
- Spec review and code quality review passed after fixing custom OpenCode provider transitions, explicit executable pinning, and AI_PILOT_CODEX_BIN precedence.
- Real local detection succeeded for Codex, Claude Code and OpenCode. Their native configuration exposed 1, 4 and 49 model choices respectively. OpenCode version probing needed normal permissions because the CLI writes its user log even for --version. No new model requests were made.
- Original main checkout is unchanged. Existing Dashboard process still needs a restart to load the updated backend; use its original terminal to preserve environment/credentials.
