# AI Pilot

A local platform for **AI-assisted software development** across an 8-stage workflow,
driven by Claude Code over MCP. Every stage has a human approval gate — Claude assists,
humans review and own outcomes.

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

One Node process, two transports, one shared core:

| Component | Role |
|-----------|------|
| **MCP server** (stdio) | Claude Code connects here and calls tools |
| **Dashboard** (Fastify + React, `127.0.0.1:4123`) | Human reviews and approves/rejects each stage |
| **AppCore** | Shared singleton — every mutation flows `mutate → persist → emit` |

State lives as files inside your repo (source of truth). `~/.specflow/registry.json`
just indexes which repos were added.

```
<your-repo>/
  specs/{TICKET}-{slug}.md               # Canonical spec (readable in PR reviews)
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
- **Approve** — advance to the next stage
- **Revise** — minor changes needed; Claude re-generates with your comment
- **Reject** — direction is wrong; Claude re-generates with your comment

### Develop stage — two-phase flow

The develop stage has an explicit plan-before-code structure:

1. **Phase A (gated)** — Claude generates a task list and implementation plan, submits
   via `record_ai_output`. You review and approve in the dashboard.
2. **Phase B (no extra gate)** — Claude implements each subtask with Write/Edit tools,
   then calls `log_implementation` (mandatory) to record what was built before marking
   the subtask done.

Implementation logs (`.specflow/impl-logs/`) feed context into the test and build stages
so Claude knows exactly what was created without re-reading the whole codebase.

### Per-repo prompt templates

Prompt templates are **yours to own**. On first `create_spec`, Claude detects if your
repo has curated templates. If not, it calls `propose_repo_templates` to inspect your
repo (CLAUDE.md, build tool, test framework, sample source file) and generates a
tailored 8-stage template set before running.

Template resolution order:
1. `<repo>/.specflow/templates/{stage}.md` + curated flag → **repo-curated**
2. `<repo>/.specflow/templates/{stage}.md` (draft, not yet curated) → **repo-draft**
3. Built-in blueprint default → **blueprint-default**

---

## MCP tools reference

| Tool | Description |
|------|-------------|
| `create_spec` | Create a new 8-stage spec. Auto-detects missing templates. |
| `get_stage_prompt` | Render the prompt for a stage with upstream context injected. |
| `record_ai_output` | Submit AI output for a stage, flip gate to `pending_review`. |
| `get_approval_status` | Poll gate status. Returns `nextSteps` to drive the loop automatically. |
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

---

## Development

```bash
npm test                # Vitest unit + integration (165 tests)
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
    spec-store.ts       # Atomic file writes, per-ticket mutex
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
