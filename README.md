# AI Pilot

A local visual platform for an **8-stage AI-assisted development workflow**, driven by
Claude Code over MCP. Add your repos by path, see every ticket on an 8-lane board, and drive
each stage's AI action + human approval gate.

```
SPEC → REQUIREMENTS → DESIGN → DEVELOP → TEST → BUILD → DEPLOY → OPS
```

Claude Code assists at every stage. Humans review, approve, and own outcomes.

## How it works

One Node process, two transports, one shared core:

- **MCP server** (stdio) — Claude Code connects and calls tools (`create_spec`, `get_stage_prompt`,
  `record_ai_output`, `advance_stage`, …).
- **Dashboard** (Fastify + React, `127.0.0.1`) — the human lives here and Approves/Rejects gates.
- **AppCore** — the shared singleton. Every mutation flows `mutate → persist → emit`, so the
  board always matches disk. A file watcher re-emits external edits so a spec written by Claude
  in one process appears live on the dashboard running in another.

State is files inside each repo (source of truth); a small `~/.specflow/registry.json` just
indexes which repos were added.

```
<repo>/
  specs/{TICKET}-{slug}.md              # Stage-0 canonical spec (PR-reviewable)
  .specflow/
    specs/{TICKET}.json                 # 8-stage state machine + gate history
    artifacts/{TICKET}/{n}-{stage}.md   # later-stage AI outputs
    templates/{stage}.md                # OPTIONAL per-repo curated prompt (overrides default)
```

### The gating invariant

Each stage has two sub-states: `aiStatus` (not_started → in_progress → done, or `stubbed`) and
`gate.status` (not_ready → pending_review → approved, or rejected → back to in_progress).
**`advance_stage` is refused unless the current gate is `approved`** (error `GATE_NOT_APPROVED`).

### Per-repo prompts

Prompt templates are **yours**. `get_stage_prompt` prefers `<repo>/.specflow/templates/{stage}.md`
and falls back to a generic blueprint default (full of `[placeholders]`) only when a repo hasn't
been curated. A sub-agent generator (inspect repo → fill placeholders → human curates) is a
declared seam for a future version.

### v1 scope

Full 8-lane board, add repos by path, per-spec progress, human gates — with **real Claude
automation wired for Stage 0 (SPEC) and Stage 1 (REQUIREMENTS)**. Stages 2–7 appear on the board
with identical gating/persistence but their AI action is a stub (`aiCapability: 'stub'`). Lighting
one up later = flip to `auto` + add its template. No migration needed.

## Usage

```bash
npm install
npm run build

# Start the dashboard (one instance for all your repos):
node dist/index.js --dashboard            # http://127.0.0.1:4123
node dist/index.js --dashboard --port 8080

# Add the MCP server to a repo's .mcp.json (see .mcp.json.example), then in
# Claude Code (run inside that repo): "work the spec for ABC-123 (some feature)".
```

The MCP server is launched by Claude Code per `.mcp.json`; it speaks JSON-RPC over stdio and
**never writes to stdout** — all logs go to stderr (hard invariant for MCP).

## Development

```bash
npm test            # vitest unit + in-process integration (62 tests)
npm run test:e2e    # Playwright happy path (needs a build first)
npm run dev:dashboard   # Vite dev server on :5174, proxies /api + /ws to :4123
```

### Test coverage of the core guarantees
- StageMachine gating truth table + "advance refused before approval".
- SpecStore atomic writes + per-spec mutex.
- MCP tools drive real on-disk state (via a real in-process MCP client).
- **stdout hygiene**: a spawned process emits only valid JSON-RPC on stdout.
- Dashboard REST + live WebSocket fan-out.
- E2E: add repo → create spec → Claude records output → live board update → human approves → advance.
