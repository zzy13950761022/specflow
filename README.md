# AI Pilot

A local platform for **AI-assisted software development** across an 8-stage workflow,
driven by Claude Code over MCP. Human approval is the default; opted-in low-risk
TEST/BUILD can receive policy approval from actual execution evidence.

```
SPEC → REQUIREMENTS → DESIGN → DEVELOP → TEST → BUILD → DEPLOY → OPS
```

---

## Quick start

**Prerequisites:** Node.js 20+, Claude Code CLI

```bash
git clone <this-repo>
cd ai-pilot
npm install
npm run build
```

**1. Start the dashboard** (keep this running in a terminal):

```bash
node dist/index.js --dashboard
# Opens at http://127.0.0.1:4123
```

**2. Register the MCP server** in your project repo's `.mcp.json`:

```json
{
  "mcpServers": {
    "ai-pilot": {
      "command": "node",
      "args": ["/absolute/path/to/ai-pilot/dist/index.js"]
    }
  }
}
```

**3. Open Claude Code** inside your project repo and say:

> "Create a spec for TICKET-123 — Add coupon discount to the shopping cart"

Claude will run the full 8-stage workflow. After each stage it waits for your approval
in the dashboard before continuing.

---

## How it works

Two transports share one domain core and cross-process ticket transactions:

| Component | Role |
|-----------|------|
| **MCP server** (stdio) | Claude Code connects here and calls tools |
| **Dashboard** (Fastify + React, `127.0.0.1:4123`) | Human reviews and approves/rejects each stage |
| **AppCore** | Shared singleton — every mutation flows `mutate → persist → emit` |

State lives as files inside your repo (source of truth). `~/.specflow/registry.json`
just indexes which repos were added.

```
<your-repo>/
  .specflow/specs/{TICKET}-{slug}.md     # Canonical spec (readable in PR reviews)
  .specflow/
    specs/{TICKET}.json                  # 8-stage state machine + full gate history
    artifacts/{TICKET}/{n}-{stage}.md    # AI outputs for each stage
    impl-logs/{TICKET}/task-*.md         # Per-subtask implementation logs (develop stage)
    templates/{stage}.md                 # Optional: your curated prompts (override defaults)
```

### The human gate

Each stage moves through two sub-states:

```
aiStatus:   not_started → in_progress → done
gate:       not_ready   → pending_review → approved
                                        ↘ rejected / needs_revision → back to in_progress
```

`advance_stage` is **refused** unless the current gate is `approved` (error code
`GATE_NOT_APPROVED`). This invariant cannot be bypassed.

The dashboard offers three verdicts when reviewing:
- **Approve** — approve the reviewed revision; advance separately when ready
- **Revise** — minor changes needed; Claude re-generates with your comment
- **Reject** — direction is wrong; Claude re-generates with your comment

### Develop stage — two-phase flow

The develop stage has an explicit plan-before-code structure:

1. **Phase A (gated)** — Claude generates a task list and implementation plan, submits
   via `record_ai_output`. You review and approve in the dashboard.
2. **Phase B (no extra gate)** — Claude implements each subtask with Write/Edit tools,
   then calls `log_implementation` (mandatory) to record what was built before marking
   the subtask done.

Task drafts before the first DEVELOP artifact do not increment its revision or
mark it outdated. Changing tasks after an artifact exists invalidates that plan
and its approval; submit the updated plan for review before implementing.

Implementation logs (`.specflow/impl-logs/`) feed context into the test and build stages
so Claude knows exactly what was created without re-reading the whole codebase.

### Per-repo prompt templates

Prompt templates are optional and user-driven. Missing templates use built-in
blueprints immediately; ticket creation does not generate templates. Use
`propose_repo_templates` for a repository brief and `write_repo_template` to save
drafts, or create template files manually. Curate them through the dashboard.

Template resolution order:
1. `<repo>/.specflow/templates/{stage}.md` + curated flag → **repo-curated**
2. `<repo>/.specflow/templates/{stage}.md` (draft, not yet curated) → **repo-draft**
3. Built-in blueprint default → **blueprint-default**

---

## Workflow templates and evidence

`create_spec` accepts `workflowKind`, `risk` and `autoChecks`. The default
`standard` uses all eight stages. `bugfix` uses SPEC/DEVELOP/TEST/BUILD/DEPLOY/OPS;
`documentation` uses SPEC/DEVELOP/OPS. Skipped stages remain visible with reasons.
The template is fixed at creation. Risk defaults to `normal`; autoChecks defaults
to false. Only opted-in low-risk TEST/BUILD can receive policy approval after
passing platform evidence and a submitted artifact. Other decisions stay manual.

Submissions must target the current stage. Pending and approved artifacts cannot
be silently overwritten. Dashboard Approve/Revise/Reject bind the reviewed
revision. `reopen_stage` requires a reason, preserves snapshots and audit history,
and invalidates affected downstream approvals, task completion and check evidence.
Running affected checks/claims must finish or be recovered first. DEVELOP plan
approval starts implementation; OPS approval completes the workflow.

Configure each project repository's `.specflow/checks.json` for its toolchain:

```json
{
  "test": {
    "command": "npm",
    "args": ["run", "test:coverage"],
    "coverageReport": "coverage/coverage-summary.json",
    "timeoutMs": 120000
  },
  "build": {
    "command": "npm",
    "args": ["run", "build"],
    "timeoutMs": 120000
  }
}
```

`run_stage_check` executes argv in the repository without a shell and records
bounded output, timing, exit code and source fingerprints. Repository-wide disk
locks reject overlapping checks across tickets and processes
so one run cannot reuse another run's coverage report. Retry after completion;
`resume_execution` recovers dead owners only after their commands have exited.
Incomplete lock metadata uses a 30-second acquisition grace period; retry resume
after that period if a process crashed while creating the lock.

TEST requires exit 0 and actual Istanbul `total.lines` coverage of at least 80%;
BUILD requires exit 0.
Configure the test runner to emit coverage-summary JSON. Its report must be a JSON
file beneath repository `coverage/`, without symlink traversal; the old report is
removed before testing. AI metrics are descriptive and cannot satisfy gates.
Missing configuration, failure, timeout or source drift blocks approval and
advancement, including downstream use of stale TEST evidence.

Fingerprints exclude directories named `.git`, `.specflow`, `node_modules` and
these exact repository-relative generated paths: `dist`, `build`, `coverage`,
`test-results`, `playwright-report`, `.playwright-mcp`, `dashboard_frontend/dist`.
For example, `src/build` remains covered. Symbolic links are not followed: target
strings are hashed, so external target content changes are not detected.

For Maven, CAP or other generators, add exact repository-relative output paths
to the top-level `generatedPaths` list in `.specflow/checks.json`. For example:

```json
{
  "generatedPaths": [
    "target",
    "srv/target",
    ".flattened-pom.xml",
    "srv/.flattened-pom.xml",
    "srv/src/gen",
    "srv/src/main/resources/edmx",
    "srv/src/main/resources/schema.sql"
  ]
}
```

Keep the existing `test` and `build` entries. Paths name a file or a directory
and its contents; globs, absolute paths and `..` are rejected. No additional
outputs are inferred from Maven or `.gitignore`. Include only generated outputs;
keep handwritten sources, tests, build configuration and reviewed published
contracts in the fingerprint. The exclusion policy is part of the fingerprint:
changing it invalidates prior evidence. This fingerprint update also requires
fresh checks for earlier evidence; failed `codeChanged` evidence is never repaired
by changing its flag. Restart the server and rerun the platform check.

## Context, scheduling and recovery

Stage prompts include approved upstream snapshots and current-revision/current-
attempt completed task logs. SPEC accepts stable acceptance criterion IDs with
Given/When/Then fields; task `requirementRef` and `testRefs` support traceability.
`get_implementation_logs` exposes raw history; `get_stage_context` filters obsolete
work and rejects missing or stale required inputs.

For scheduled tasks, call `claim_subtask`, implement, call `log_implementation`
with the returned `claimId`, then `set_subtask_completed(completed=true, claimId)`.
Dependencies must be complete and declared files must not conflict with running
tasks. Release abandoned claims using `release_subtask`; new attempts need new
logs. Unclaimed sequential tasks remain supported. Prefer idempotent completion
over `toggle_subtask`. File declarations are scheduling inputs, not enforcement
of what an external agent can modify.

`get_execution_status` and `get_next_actions` identify the next valid operation.
Pause blocks new execution but permits reads and human review. Resume recovers
interrupted checks explicitly without automatically rerunning commands. Completed
and paused workflows have no next actions. The platform provides scheduling APIs
for external agents; it does not launch agents, push or deploy automatically.

Schema v3 retains revision, workflow, execution and rework history. Completed v2
tickets with unchanged artifacts and a full historical approval trail retain
their completed status and task completion. `legacyCompletion` records the original
completion time; it does not issue new check evidence or approvals. Reopen explicitly
when new work is needed. Incomplete legacy tickets still invalidate approvals and
reset task completion/claims with new attempts; first mutation persists migration.
Re-review and revalidate incomplete workflows before advancing.
Immutable snapshots, including structured metadata and requirements sidecars, live
in `.specflow/artifacts/{TICKET}/history/`. Raw logs and source files remain.

For completed tickets already reset by the earlier migration, preview repair with
`node scripts/restore-legacy-completion.mjs /path/to/repo TICKET-ID`. Add `--apply`
to write it after checking the preview. The script requires an unchanged completed
legacy approval trail, rejects rework/new output/running claims, locks each ticket
and saves original JSON under `.specflow/backups/` before atomic replacement.

## Shared Claude/Codex Specflow skill

The maintained workflow skill is [skills/specflow/SKILL.md](skills/specflow/SKILL.md).
It follows the MCP's current execution actions, templates, revision approvals,
claim-aware development, real check evidence, rework and recovery. Repository-
specific SAP conventions are a conditional reference rather than universal rules.

Install user-level shared links from this checkout:

```bash
python3 scripts/install-specflow-skill.py         # Preview only
python3 scripts/install-specflow-skill.py --apply # Back up existing skills and link
```

Codex discovers `~/.agents/skills/specflow`, linked to this checkout's skill. Claude
uses `~/.claude/skills/specflow`, linked to the shared location. Existing copies are
moved into `~/.agents/skill-backups/` or `~/.claude/skill-backups/` before replacement.
Later edits in the checkout update both clients; keep this checkout available.
Repeated installation is idempotent. Start a new/reloaded client session for skill
discovery, and ensure the AI Pilot MCP is separately registered in that client.

Invoke in Claude with `/specflow TICKET-ID description`, or in Codex with
`$specflow TICKET-ID description`. Natural-language requests to use Specflow also
match the skill. No workflow is started by installing it.

Installer tests: `python3 -m unittest discover -s tests/skills -p test_install_specflow.py`.
Behavioral evaluation scenarios are in `tests/skills/specflow-scenarios.json`; run
them as simulated skill applications without operating on live tickets.

## Personal and team repository synchronization

The standalone repository and the team's `mcp/ai-pilot` directory use two-way Git
subtree merges. Teammates work and commit normally in the monorepo; the maintainer
handles synchronization. A personal GitHub remote and a team GitHub remote can be
used independently. The maintained Specflow skill travels with the component at
`skills/specflow`; changing the team's top-level skill entry point requires a
separate review of its platform conventions.

```bash
python3 scripts/sync-ai-pilot.py status
python3 scripts/sync-ai-pilot.py import # Team → standalone preview
scripts/sync-to-gp.sh                  # Standalone → team preview
```

Defaults are this checkout and `~/Project/Giant-Panda-AI-Tools-main`, with prefix
`mcp/ai-pilot`. Override with `--source`, `--team`, `--prefix`, `--source-ref` and
`--team-ref`. The tool uses local committed refs; fetch the relevant remote
branches first and select the intended refs. Status compares committed trees and
reports dirty working trees separately. It does not include uncommitted features.

For the first synchronization, establish shared ancestry from **reviewed historical
bases**. In these local checkouts, `a837ec2` is a candidate team base and `4721fc1`
is the corresponding standalone commit. Their trees differ, so review baseline
conflicts rather than treating these commits as identical. Select a source base
that precedes the changes you intend to merge:

```bash
python3 scripts/sync-ai-pilot.py bootstrap \
  --source-base 4721fc1 --team-base a837ec2 \
  --workspace /tmp/ai-pilot-bootstrap --apply
```

Both input checkouts must be clean before `--apply`; review and commit intended
changes first, leaving private local configuration out of Git. The operation
creates isolated clones and a `codex/ai-pilot-*` result branch. Input checkouts
remain untouched. Only tracked committed content is merged; already tracked
configuration is still tracked and must be reviewed. No automatic push occurs.

If JSON reports `status: conflict` (exit 2), resolve the listed files in
`result.repo`, stage them with `git add`, then run:

```bash
python3 scripts/sync-ai-pilot.py continue \
  --workspace /tmp/ai-pilot-bootstrap --apply
```

Unresolved conflicts remain paused. `operation.json` records source/team/split
SHAs, merge steps and the result SHA. Keep this workspace until the result is
reviewed and integrated. Output clones have local input repos as their `origin`,
so publish to the appropriate remote explicitly. Retain the merge history:
**squashing or cherry-picking a sync result loses ancestry needed by later syncs.**
For example, after reviewing the standalone result:

```bash
# In the original standalone checkout; replace RESULT_BRANCH from JSON.
git fetch /tmp/ai-pilot-bootstrap/source RESULT_BRANCH
git switch -c codex/review-ai-pilot-sync FETCH_HEAD
# Review and test this branch, then publish it explicitly for a merge PR.
```

After integrating the bootstrap result into the standalone branch, use incremental
operations with new workspace paths:

```bash
python3 scripts/sync-ai-pilot.py import --workspace /tmp/ai-pilot-import --apply
python3 scripts/sync-ai-pilot.py export --workspace /tmp/ai-pilot-export --apply
```

Review and integrate the import result before exporting it (or pass its clone as
`--source`). Review the export branch in the team clone before publishing a team
PR. Export preserves files outside the prefix and can incorporate concurrent
team edits. `needsFollowupImport: true` means those team changes still need to be
imported into standalone; it does not discard them to force equality. Fetch and
merge newer target changes and rerun relevant tests before publication.

Use `status --require-equal` as a release/CI check: exit 1 means the selected
committed trees differ. Two independent repos are synchronized at recorded SHAs,
not atomically or continuously. To cancel a conflicted operation, leave the
original repos alone and discard its temporary workspace when no longer needed.

Sync regression tests: `python3 -m unittest discover -s tests/sync -p 'test_*.py'`.
Design: [repository sync spec](docs/superpowers/specs/2026-11-10-repository-sync-design.md).

## MCP tools reference

| Tool | Description |
|------|-------------|
| `create_spec` | Create a standard/bugfix/documentation ticket; report template availability. |
| `get_stage_prompt` | Render the prompt for a stage with upstream context injected. |
| `record_ai_output` | Submit AI output for a stage, flip gate to `pending_review`. |
| `get_approval_status` | Bounded wait: default 30s, maximum 60s, 0 for a snapshot; returns structured actions. |
| `advance_stage` | Move to next stage (refused unless gate is `approved`). |
| `request_revision` | Third verdict: minor revision needed (gate → `needs_revision`). |
| `set_develop_subtasks` | Set the develop task list (with prompt/leverage/requirementRef). |
| `toggle_subtask` | Mark a subtask completed/not-completed. |
| `log_implementation` | Record what was built after coding a subtask (mandatory). |
| `get_implementation_logs` | Read implementation logs; used by test/build for context. |
| `propose_repo_templates` | Inspect repo and return a brief for template generation. |
| `write_repo_template` | Save a generated template (draft until curated in dashboard). |
| `list_repos` | List registered repos. |
| `list_specs` | List all specs in a repo. |
| `get_spec` | Get full spec state with gate history. |
| `reopen_stage` | Reopen reached work with a reason; invalidate downstream results and retain history. |
| `run_stage_check` | Execute configured TEST/BUILD and persist actual evidence. |
| `get_stage_context` | Read approved snapshots and current valid implementation logs. |
| `get_traceability` | Map criteria to tasks, files and tests; report missing links. |
| `get_execution_status` / `get_next_actions` | Read recovery state and structured next operations. |
| `pause_execution` / `resume_execution` | Pause new work or recover interrupted execution. |
| `claim_subtask` / `release_subtask` | Claim dependency-ready work without declared-file conflicts, or release with claimId. |
| `set_subtask_completed` | Complete idempotently with a current log and claimId when claimed. |

---

## Development

```bash
npm test                # Vitest unit + integration
npm run test:frontend   # Frontend component tests
npx tsc -p dashboard_frontend/tsconfig.json # Frontend type check
npm run test:e2e        # Playwright happy path (requires a build)
npm run dev:dashboard   # Vite dev server on :5174, proxies /api + /ws to :4123
npx tsc --noEmit        # Type-check without building
```

After any code change:

```bash
npm run build           # Recompile dist/index.js
# Then restart the MCP server (reload Claude Code or run /mcp)
```

### Architecture invariants

- **stdout is JSON-RPC only.** The MCP process never writes to stdout. All logs go to
  stderr. `installStdoutGuard()` in `src/index.ts` redirects stray `console.log`.
  A spawn test (`src/mcp/hygiene.test.ts`) enforces this.
- **Files are the source of truth.** Every mutation flows `AppCore → SpecStore write →
  EventBus emit → WS fan-out`. The registry index is disposable.
- **The gating invariant is sacred.** `advance_stage` stays refused unless the gate is
  `approved`. No code path weakens this.

---

## Project structure

```
src/
  core/
    schemas.ts          # Zod schemas — single source of truth for all types
    stage-machine.ts    # Pure 8-stage domain logic (no I/O)
    spec-store.ts       # Atomic writes and cross-process ticket transactions
    impl-log-store.ts   # Implementation log read/write
    app-core.ts         # Singleton wiring everything together
    repo-registry.ts    # ~/.specflow/registry.json index
    event-bus.ts        # In-process pub/sub
  mcp/
    server.ts           # MCP tool definitions (thin transport layer)
  dashboard/
    server.ts           # Fastify REST + WebSocket fan-out
  prompts/
    templates.ts        # Template resolution (repo-curated > draft > blueprint)
    template-defaults.ts # Blueprint defaults for all 8 stages
  index.ts              # Entry point (--dashboard flag or MCP stdio)
dashboard_frontend/     # React + Vite + Tailwind v4 (SAP Joule dark theme)
e2e/                    # Playwright end-to-end tests
```
