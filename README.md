# AI Pilot

A local platform for **AI-assisted software development** across an 8-stage workflow,
driven by Claude Code, Codex or OpenCode over MCP. Human approval is the default; opted-in low-risk
TEST/BUILD can receive policy approval from actual execution evidence.

```
SPEC → REQUIREMENTS → DESIGN → DEVELOP → TEST → BUILD → DEPLOY → OPS
```

---

## Quick start

**Prerequisites:** Node.js 20+, an MCP-compatible coding client

```bash
# From the AI Pilot component directory (mcp/ai-pilot in the team repository):
npm install
npm run build
```

**1. Start the dashboard** (keep this running in a terminal):

```bash
node dist/index.js --dashboard
# Opens at http://127.0.0.1:4123
```

**2. Register the MCP server** in your coding client. For **Claude Code**, merge
this entry into your project repo's `.mcp.json`:

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

For **Codex**, merge the following table into your user-level
`~/.codex/config.toml` (see the [official MCP configuration guide](https://developers.openai.com/codex/mcp/)):

```toml
[mcp_servers.ai-pilot]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/ai-pilot/dist/index.js"]
```

Use the absolute path to your Node.js 20+ executable and this checkout's built
entry point. Codex does not use Claude's project `.mcp.json` for this registration.
For **OpenCode**, follow the team setup guide below. Reload the client after
registration; installing the shared skill alone does not register an MCP server.

**3. Open your coding client** inside your project repo and say:

> "Create a spec for TICKET-123 — Add coupon discount to the shopping cart"

The assistant drives the workflow and waits for approval in the dashboard before
advancing. The standard template uses all 8 stages; bugfix and documentation
templates select their own stages. TEST/BUILD policy approval requires explicit
low-risk opt-in and successful platform checks.

---

### OpenCode setup in the team repository

For Giant-Panda-AI-Tools installations, use the [OpenCode setup guide](https://github.tools.sap/cx-commerce/Giant-Panda-AI-Tools/blob/opencode/config/README.md)
for native skill discovery, dependency installation, environment files and client
configuration. Launch paths must refer to your checkout. Merge server entries
into your client configuration to retain unrelated settings.

## How it works

Two transports share one domain core and cross-process ticket transactions:

| Component | Role |
|-----------|------|
| **MCP server** (stdio) | The coding client connects here and calls tools |
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
- **Revise** — minor changes needed; the assistant re-generates with your comment
- **Reject** — direction is wrong; the assistant re-generates with your comment

Inline review annotations let you select text in the current, non-stale markdown
artifact awaiting review and attach revision notes.
Revise combines those notes with an optional overall comment. Draft annotations
are scoped to the current ticket, stage and artifact revision; new revisions
start fresh. Reloading the page also clears drafts; notes are saved in the gate
comment/history when you submit Revise. Structured requirements views do not use
the markdown annotation editor. Approve, Revise and Reject remain bound to the
loaded revision.

### Develop stage — two-phase flow

The develop stage has an explicit plan-before-code structure:

1. **Phase A (gated)** — The assistant generates a task list and implementation plan, submits
   via `record_ai_output`. You review and approve in the dashboard.
2. **Phase B (implementation and result review)** — The assistant implements each subtask with its coding tools,
   then calls `log_implementation` (mandatory) to record what was built before marking
   the subtask done. Each completed subtask then requires human approval of its
   implementation report before entering TEST. Reports bind the plan revision,
   task attempt and source fingerprint; changed code invalidates old approvals.

Task drafts before the first DEVELOP artifact do not increment its revision or
mark it outdated. Changing tasks after an artifact exists invalidates that plan
and its approval; submit the updated plan for review before implementing.

Implementation logs (`.specflow/impl-logs/`) feed context into the test and build stages
so the assistant knows what was created without re-reading the whole codebase.

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

For Maven projects using JaCoCo, configure the test command or a wrapper to run
tests, generate a fresh XML report, and convert its report-level `LINE` counter
to `coverage/coverage-summary.json`. The required shape is, for example,
`{"total": {"lines": {"total": 100, "covered": 85, "pct": 85}}}`.
Use measured counts (`total = missed + covered`, `pct = covered / total * 100`);
propagate test/conversion failures and reject missing or stale JaCoCo reports.
AI Pilot reads the JSON summary, not JaCoCo XML directly.

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
contracts in the fingerprint. The complete test/build command configuration and
exclusion policy are part of the fingerprint: changing either invalidates prior
implementation approvals and check evidence. This fingerprint update also requires
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
for external agents and an optional local Codex runner; pushing and deployment
remain separate explicitly authorized operations.

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

## Dashboard-driven Agent execution

Start Dashboard with the built-in runner:

```bash
npm run build
npm start -- --dashboard
```

Use `--no-runner` for a review-only Dashboard. `--runner` remains accepted
for existing launch commands. In the header, open **Agent settings** next to
**Add repo**, add an execution configuration, and choose Codex, Claude Code or
OpenCode. Configuration names default to the Agent name; a custom name is optional
under **Advanced settings**. **User default** selects one saved configuration for
all repositories. Existing tickets retain their selected configuration; an explicit
ticket selection overrides the default.

Local configuration is read automatically. **Model** defaults to **Use local
current model**; searchable choices come from models declared in native settings
(Codex profiles, Claude model aliases, and OpenCode providers). These choices do
not guarantee service access. **Custom model…** remains available; OpenCode uses
its provider/model-id format and updates the provider together with the model.
Choosing a locally configured model clears previous connection overrides.

When no program is explicitly configured, detection checks PATH and conventional
local installations, including Codex bundled with VS Code on macOS. A broken
installation does not prevent finding another working one. **Advanced settings**
contains the installation selector, program/config paths, provider, endpoint and
credential environment-variable name. An explicitly selected broken program is
reported rather than silently replaced. The app does not install or repair global
tools. **Refresh local config** rereads settings; **Test connection** sends one
small model request in a temporary workspace without creating a ticket.

Profiles can inherit the native configuration or override the model, provider,
endpoint, configuration path and a credential environment-variable name. Set the
variable's value in the environment that launches Dashboard. Profiles are stored
under `AI_PILOT_HOME` (default `~/.specflow`), outside repository source;
credential values are never part of Dashboard settings or ticket snapshots.
Codex reads TOML, Claude Code reads its settings JSON, and OpenCode supports both
legacy `provider/options` and v2 `providers/settings` configurations.
Hyperspace endpoints and model identifiers remain specific to each Agent's
protocol. Copy only the selected provider's transport, not native hooks, plugins,
MCP servers or command approval preferences. OpenCode configuration compatibility
is checked against its [official schema](https://opencode.ai/config.json).

**Create Spec** opens a modal containing repository, ticket, title, description,
workflow, risk and execution settings. Choose **Run in Dashboard**, select a saved
execution configuration and click **Create & Start**. Creation persists the ticket before the
runner starts; launch failures remain on the ticket with a Retry action. Manual
creation stays available without any Agent configuration. The board searches
ticket IDs/titles, filters state/stage/workflow and sorts results; URL query
parameters preserve filters when returning from a detail page.

Each managed ticket snapshots its selected profile and keeps a native session ID.
Approval, revision and rejection persist the human decision before waking the
scheduler. A generated artifact ends its model turn at the review gate. No Agent
polls for approval, and the user does not need to type a continuation message in
an IDE. Changing defaults does not update existing ticket profiles. Explicit
profile changes start a new native session. Implementation completion still
requires human approval of current subtask reports before TEST.

The ticket JSON is the durable queue; events wake reconciliation. Startup reads
queued work, run/state-version checks reject duplicate or stale submissions, and
only one managed run may own a ticket. Failed/interrupted work requires inspection
and explicit retry. Each ticket has a separate Git worktree; committed source is
required before its first creation. Existing worktrees and partial changes are
preserved. Install dependencies or configure an explicit setup/check wrapper in
that workspace. Canonical artifacts, decisions and check commands stay in the
registered repository. Actual source/check evidence belongs to the worktree.

Codex uses native App Server JSON-RPC with read-only artifact turns and
workspace-write implementation turns. Claude Code uses its structured print
interface, and OpenCode uses standalone JSON execution. Those two adapters expose
read tools and return complete file changes, which the host validates and applies
inside the ticket worktree. They do not run implementation shell commands;
configured TEST/BUILD commands are executed by the platform. Filesystem paths,
symlinks, canonical workflow/configuration directories and source drift are checked
before host-applied writes. Unknown interactive permissions fail the turn rather
than implying human approval. These are managed runtime/tool boundaries, not
independent identity attestation against unrestricted same-user local programs.

Every Stage starts with **Continue in VS Code**. **Copy context** is read-only.
**Continue in IDE** cancels the managed run, waits for the owned process to exit,
and transfers the ticket to IDE execution. Active platform checks must finish
first. The copied context names the canonical repository ID, ticket and actual
worktree. Open that workspace and invoke the installed Specflow skill with AI
Pilot MCP available. The skill reads current persisted state even when viewing an
older stage. A Dashboard session is not promised to appear in an IDE chat list.

Before **Resume in Dashboard**, stop work in the IDE and complete/release active
task claims. The backend checks claims and running checks, rereads workflow state,
and starts a fresh native session from canonical context to incorporate IDE edits.
It preserves the worktree, decisions and history. Source changes invalidate prior
implementation/check evidence through the existing gates. Publishing and deployment
continue to require their own explicit authorization.

Settings, native diagnostics and ownership transfers require the browser review
capability, as do human review decisions. Pausing fences late output and requests
process cancellation. A retained live child blocks recovery rather than allowing
a concurrent writer.

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

## MCP tools reference

| Tool | Description |
|------|-------------|
| `create_spec` | Create a standard/bugfix/documentation ticket; report template availability. |
| `get_stage_prompt` | Render the prompt for a stage with upstream context injected. |
| `record_ai_output` | Submit AI output for a stage, flip gate to `pending_review`. |
| `get_approval_status` | Bounded wait: default 30s, maximum 60s, 0 for a snapshot; returns structured actions. |
| `submit_implementation_review` / `get_implementation_review` | Submit and read completed-subtask reports; human review is required before TEST. |
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
# Restart the dashboard and reload/reconnect the MCP server in your coding client.
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
