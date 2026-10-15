# AI Pilot — Phased Implementation Plan

This document is the hand-off contract for building out AI Pilot across multiple
Claude Code sessions. **Phase 1 (v1) is already built and committed.** Each
later phase below is self-contained: a session can pick one phase, read it top to
bottom, and complete it without needing the others. Phases are ordered by
dependency — do them in order unless a phase says otherwise.

> Read this first, then read `README.md` for the runtime model and
> `../AI-PILOT-PLAN.md` for the original architecture rationale. The SAP source
> of truth for prompt content and governance is
> `~/Downloads/AI-Assisted-Development-Blueprint.docx`.

---

## Ground rules (apply to every phase)

- **Invariant #1 — stdout is JSON-RPC only.** The MCP process must never write
  to stdout. All logs go through `src/core/logger.ts` (stderr). `installStdoutGuard()`
  in `src/index.ts` redirects stray `console.log`. There is a spawn test
  (`src/mcp/hygiene.test.ts`) that fails if anything leaks — keep it green.
- **Invariant #2 — files are the source of truth.** Every mutation flows
  `AppCore → SpecStore write → EventBus emit → WS fan-out`. The `~/.specflow/registry.json`
  is a disposable index. Never make the dashboard the authority.
- **TDD, inside-out.** Write the domain/unit test first, then the implementation,
  then wire the transport. Do not mark a phase done with failing or skipped tests.
- **ESM, Node16 resolution.** Relative imports MUST carry the `.js` extension in
  `.ts` source (e.g. `import { AppCore } from './core/app-core.js'`). `strict` is on.
- **zod is the single schema source.** Extend `src/core/schemas.ts`; infer TS
  types from zod, never hand-write a parallel interface.
- **The StageMachine is pure.** It takes a `SpecFile` and returns a new one; no
  I/O. Persistence belongs to `SpecStore`, orchestration to `AppCore`.
- **Keep the gating invariant sacred.** `advance_stage` must stay refused unless
  the current gate is `approved` (`GATE_NOT_APPROVED`). Any new stage behaviour
  must not weaken this.
- **Verification bar for every phase:** `npm run build` clean, `npm test` green
  (unit + integration), `npm run test:e2e` green, `npx tsc --noEmit` clean.

---

## Phase 1 — v1 thin vertical slice ✅ DONE (committed)

Baseline the later phases build on. Already implemented and tested (63 tests +
1 e2e). Do not redo; this section is the map of what exists.

**Core (`src/core/`)**
- `schemas.ts` — zod schemas + `STAGE_IDS` (the 8 stages), `SpecFile`, `Stage`
  (`aiStatus`, `aiCapability`, `gate`, optional `subtasks`), tool-input schemas.
- `stage-machine.ts` — pure 8-stage logic: `createSpec`, `recordAiOutput`,
  `approve`, `reject`, `advance` (+ `GateNotApprovedError`). Stages 0–1 =
  `aiCapability:'auto'`, 2–7 = `'stub'`. `develop` seeded with `subtasks: []`.
- `spec-store.ts` — atomic writes (temp+rename), per-ticket async mutex, zod
  validation on read, artifact writing (`specs/{TICKET}.md` for stage 0,
  `.specflow/artifacts/{TICKET}/{n}-{stage}.md` otherwise).
- `repo-registry.ts` — `~/.specflow/registry.json` index (`AI_PILOT_HOME`
  override for sandboxes). `add` validates dir, `remove` never deletes repo files.
- `app-core.ts` — the singleton wiring all of the above + EventBus; every method
  is `mutate → persist → emit`. Reads upstream artifact to feed the next prompt.
- `event-bus.ts` — in-process pub/sub. `file-watcher.ts` — chokidar (polling)
  on `<repo>/.specflow`, re-emits `spec.updated` so a different process's write
  reaches the dashboard. `logger.ts` — stderr logger + stdout guard.

**Prompts (`src/prompts/templates.ts`)**
- `PromptTemplates.resolve/render` — prefers `<repo>/.specflow/templates/{stage}.md`,
  falls back to inline `BLUEPRINT_DEFAULTS` (all 8 stages, with `[placeholders]`;
  stage 6/7 carry PCI/GDPR + log-sanitization governance verbatim).
- `generateCuratedTemplate()` — **declared seam that throws in v1.** This is the
  hook Phase 2 implements.
- Interpolation vars: `{{ticketId}}`, `{{title}}`, `{{upstreamArtifact}}`.

**MCP (`src/mcp/server.ts`)** — `McpServer` with 8 tools: `list_repos`,
`list_specs`, `get_spec`, `create_spec`, `get_stage_prompt`, `record_ai_output`,
`get_approval_status`, `advance_stage`. All SDK usage isolated here.

**Dashboard (`src/dashboard/`)** — Fastify REST (repos/specs CRUD, approve/reject,
`/api/repos/pick` native Finder picker via `folder-picker.ts`) + `/ws` WebSocket
fan-out + static SPA. Binds 127.0.0.1.

**Frontend (`dashboard_frontend/`)** — React + Vite + Tailwind v4, SAP Joule dark
glassmorphism. 8-lane board, repo picker, spec cards with per-stage status/gate,
Approve/Reject, live WS. A spec sits in its first non-approved stage's lane.

**Entry (`src/index.ts`)** — `--dashboard` = dashboard+watcher only; default =
MCP stdio only. The two run as separate processes sharing files.

---

## Phase 2 — Sub-agent per-repo prompt generator

**Goal.** Implement the `generateCuratedTemplate` seam: a sub-agent inspects a
repo and produces a curated 8-stage prompt set for it, filling the blueprint
`[placeholders]` with that repo's real modules, build tool, test framework, and
conventions. A human curates before the templates become authoritative. This is
the blueprint's central lesson: *"auto-generation is a starting point, not a
finish line; high-quality AI config requires curation."*

**Why first.** It is additive (no change to the gating core), it is the feature
the user explicitly asked for, and it makes stages 3–7 actually useful when they
are lit up later.

**Design.**
- The generator does NOT call an LLM directly from the Node process. Instead it
  produces a **generation request** that Claude Code (the agent already connected
  over MCP) fulfils, then writes back via a new tool. This keeps the Node process
  LLM-free and respects Invariant #1.
- Flow:
  1. New MCP tool `propose_repo_templates(repoId)` → AppCore gathers repo
     signals (reads `CLAUDE.md`, `package.json`/`pom.xml`/`build.gradle`,
     detects test framework, samples a representative source file) and returns a
     structured "generation brief" + the blueprint defaults as the base to adapt.
  2. Claude drafts curated templates per stage from that brief.
  3. New MCP tool `write_repo_template(repoId, stageId, content)` → persists to
     `<repo>/.specflow/templates/{stage}.md` (status: `draft`).
  4. The dashboard shows draft templates with a **Curate / Approve** action; only
     curated templates are marked authoritative (a sidecar
     `<repo>/.specflow/templates/{stage}.meta.json` with `{curated: boolean}`).
  5. `PromptTemplates.resolve` already prefers the repo file; extend it to report
     `source: 'repo-curated' | 'repo-draft' | 'blueprint-default'`.

**Files to add/change.**
- `src/core/repo-introspector.ts` (new) — detects build tool, test framework,
  reads CLAUDE.md, picks a sample file. Pure/async, unit-tested with temp repos.
- `src/prompts/templates.ts` — implement `generateCuratedTemplate` to return the
  brief (not throw); add `writeRepoTemplate`, `templateMeta`, and the richer
  `source` enum.
- `src/mcp/server.ts` — add `propose_repo_templates`, `write_repo_template`.
- `src/dashboard/server.ts` — endpoints to list draft templates and mark curated.
- Frontend — a "Prompts" panel per repo showing the 8 stage templates, their
  source badge, and a curate toggle.

**Tests (write first).**
- Introspector detects Maven vs Gradle vs npm vs pytest from fixture repos.
- `write_repo_template` persists to the right path; `resolve` then returns
  `repo-draft`, and after curation `repo-curated`.
- MCP integration: `propose_repo_templates` returns a brief that names the
  detected framework.

**Acceptance.** A repo with a `pom.xml` + JUnit yields a brief that mentions
Maven/JUnit; Claude can write a curated `test.md`; the dashboard shows it as
curated and `get_stage_prompt` returns it over the blueprint default.

---

## Phase 3 — DEVELOP sub-task checklist ✅ DONE (committed)

**Goal.** Make the `subtasks: []` placeholder on the DEVELOP stage real: a spec's
DEVELOP stage holds an ordered checklist of implementation sub-tasks (the old
"tasks.md" concept, now scoped inside one stage), each individually checkable,
feeding DEVELOP's progress.

**Why before lighting up stages.** DEVELOP's automation (Phase 5) depends on this
structure existing, and it is self-contained domain work.

**Design.**
- Extend `SubtaskSchema` usage: a sub-task has `id`, `description`, `completed`,
  optional `prompt` (per-subtask AI guidance) and `requirementRef`.
- StageMachine gains pure methods: `addSubtask`, `toggleSubtask`,
  `setSubtasks` (replace wholesale, used when Claude generates the list). DEVELOP
  stage `aiStatus` derives from sub-tasks: `done` only when all completed.
- Gate rule unchanged: DEVELOP's gate still needs human approval to advance; the
  checklist drives `aiStatus`, not the gate.

**Files.**
- `src/core/schemas.ts` — extend `SubtaskSchema`.
- `src/core/stage-machine.ts` — the sub-task methods + derived aiStatus; new unit
  tests (toggle, all-complete→done, order preserved).
- `src/core/app-core.ts` — orchestration methods + emit.
- `src/mcp/server.ts` — tools `set_develop_subtasks`, `toggle_subtask`.
- `src/dashboard/server.ts` — endpoints for the above.
- Frontend — expand the DEVELOP card to show the checklist + progress.

**Acceptance.** Create a spec, advance to DEVELOP (after approvals), set 3
sub-tasks, toggle them; DEVELOP `aiStatus` flips to `done` only when all 3 are
checked; board progress reflects it live.

---

## Phase 4 — Structured artifact model (DEPLOY/OPS prerequisite)

**Goal.** Replace the v1 simplification where every later-stage output is a single
`{n}-{stage}.md`. DEPLOY and OPS products are *actions and external state*
(deployment checklist + status, metrics, RCA, runbook), not just prose. Introduce
a typed artifact model so those stages can carry structured data.

**Why before Phase 5's DEPLOY/OPS automation.** Lighting up DEPLOY/OPS on top of
the flat markdown model would bake in the wrong shape. Fix the model first.

**Design.**
- New `ArtifactSchema` (zod) in `schemas.ts`: a discriminated union by stage —
  e.g. `{ kind: 'markdown', path }` (default for spec/req/design/develop/test/build),
  `{ kind: 'deploy-checklist', items: [...], status, rollbackCriteria }`,
  `{ kind: 'ops-report', logsSanitized: boolean, rcaPath, runbookPath, metrics }`.
- `Stage.artifact?: Artifact` replaces the bare `artifactPath?: string`
  (keep `artifactPath` as a derived convenience for markdown kinds, or migrate —
  **note: no existing users, so a breaking schema change is fine; bump
  `SCHEMA_VERSION`**).
- `SpecStore.writeArtifact` becomes kind-aware.
- Governance stays enforced in the artifact: OPS artifacts carry a
  `logsSanitized` flag the dashboard surfaces; DEPLOY artifacts flag
  payment/GDPR-scoped changes per the blueprint.

**Files.** `schemas.ts`, `spec-store.ts`, `stage-machine.ts` (record typed
artifact), `app-core.ts`, MCP `record_ai_output` (accept a typed payload),
frontend (render artifact by kind).

**Tests.** Round-trip each artifact kind through SpecStore; schema rejects an
ops-report with `logsSanitized:false` being marked done (or at least surfaces it).

**Acceptance.** `record_ai_output` for DEPLOY accepts a checklist artifact and the
dashboard renders it as a checklist, not raw markdown; `SCHEMA_VERSION` bumped and
read path validates.

---

## Phase 5 — Light up stages 2–7 (one stage at a time)

**Goal.** Flip stub stages to real Claude automation. The board/gating/persistence
are already identical for all 8 stages, so lighting one up is: (a) flip its
`aiCapability` to `'auto'`, (b) ship/curate its prompt (Phases 2 provides the
mechanism), (c) ensure its artifact kind (Phase 4) is handled.

**Do them in blueprint order and as separate sub-tasks**, each independently
shippable:
- 5a DESIGN, 5b DEVELOP (depends on Phase 3), 5c TEST, 5d BUILD,
  5e DEPLOY (depends on Phase 4), 5f OPS (depends on Phase 4).

**Design.**
- Replace the hardcoded `AUTO_STAGES` set in `stage-machine.ts` with a per-repo
  or global capability config so lighting up a stage is config, not a code edit
  where possible. Minimum: make `AUTO_STAGES` a single source constant and add a
  test asserting which stages are auto.
- Each stage's prompt must be curated for the target repo (Phase 2). Until
  curated, keep it `stub` to avoid shipping generic Java-applies-to-anything
  prompts (blueprint warning).
- Preserve governance gates: DESIGN may need security sign-off; DEPLOY enforces
  PCI/GDPR; OPS enforces log sanitization before the artifact can be recorded.

**Tests.** For each lit stage: `get_stage_prompt` returns curated content;
`record_ai_output` writes the correct artifact kind; `advance` still gated.

**Acceptance per sub-stage.** The stage shows `auto` on the board, Claude can run
its action end-to-end against a curated repo, and the human gate still blocks
advance until approved.

---

## Cross-cutting backlog (not phased; pick up opportunistically)

- **Config/port handling** — `--help`, port-in-use detection, `AI_PILOT_HOME`
  documented. (Partially present in `index.ts`.)
- **Dashboard: gate history** — show `gateHistory` inline on the card. (Artifact
  **viewer** half is DONE: `GET .../artifact?stageId=` + the SpecCard "View
  generated content" expander let a reviewer read the AI output before approving.)
- **Metrics** — the blueprint tracks stage coverage, cycle time, build success.
  A later phase could surface these per repo.
- **`.mcp.json.example` per-repo onboarding doc** — expand into a short
  "add AI Pilot to your repo" guide.

### Review-experience enhancements (mimic spec-workflow-mcp, deferred from the artifact-viewer work)

The artifact-review feature shipped a deliberately minimal v1 (plain-text preview,
binary Approve/Reject). These four build on it, ordered by effort. Two low-cost
hooks were pre-wired so these need no schema migration / lose no history:
- **Hook A** — `GateStatusSchema` (`src/core/schemas.ts`) already carries a reserved
  `needs_revision` value; no transition writes it yet. `GATE_STYLES` (App.tsx) has
  its style key.
- **Hook B** — every `recordAiOutput` already writes a timestamped snapshot under
  `.specflow/artifacts/{TICKET}/history/` and appends `{path, at}` to
  `stage.artifactHistory` (`src/core/spec-store.ts` + `stage-machine.ts`).

- **Markdown rich rendering** (🟢 small) — swap the preview `<pre>` in
  `ArtifactPreview` (App.tsx) for `react-markdown`. Pure presentation, no data
  change, no backend touch.
- **Three-verdict review `needs-revision`** (🟡 medium) — Hook A already reserves
  the enum. Add a StageMachine transition (`aiStatus` → `in_progress`, keep the
  comment to feed the next prompt), a third gate action in the dashboard + the
  reject-style comment input, and wire an MCP/REST action. Keep the gating
  invariant: `advance` still only on `approved`.
- **Snapshot + diff viewer** (🟠 medium-large) — Hook B already captures history.
  Add a `GET .../artifact/history` endpoint and a diff UI (unified/split) comparing
  two snapshots (or snapshot vs. current). Pure additive once history data exists.
- **Inline annotations / selection highlight** (🔴 large, purely additive) — select
  text in the preview → record character offsets → store an annotations array on
  the stage/artifact → re-highlight on reload. Use the raw-text (not markdown-
  rendered) view for anchoring to avoid DOM-offset drift (the reason
  spec-workflow-mcp's annotate mode uses plain text).

---

## Phase hand-off checklist (paste into each session)

```
[ ] Read docs/IMPLEMENTATION-PLAN.md (this file) + README.md
[ ] Confirm which Phase you own; re-read its section fully
[ ] Write tests first (TDD, inside-out)
[ ] Respect Invariant #1 (stdout) and #2 (files are truth)
[ ] npm run build clean
[ ] npm test green (unit + integration)
[ ] npm run test:e2e green
[ ] npx tsc --noEmit clean
[ ] Commit with a message naming the Phase
```
