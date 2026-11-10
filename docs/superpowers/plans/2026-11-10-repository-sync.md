# Repository Synchronization Implementation Plan

> For agentic workers: execute sequentially in this session with executing-plans.
> Use temporary repositories for Git integration tests; preserve live working trees.

**Goal:** Replace overwrite-based AI Pilot synchronization with reviewed two-way Git subtree merges.

**Architecture:** A Python CLI orchestrates Git inside temporary clones. Operations
persist their source refs, merge steps and output in an operation record. Conflicts
remain in the clone for normal Git resolution and explicit continuation.

**Tech Stack:** Python standard library, Git subtree, unittest.

## Task 1 — Executable regression scenarios

- [x] Create `tests/sync/test_repository_sync.py` using temporary independent and monorepo fixtures.
- [x] Verify preview, bootstrap, incremental import/export, conflict/continue and dirty-source refusal.
- [x] Run `python3 -m unittest discover -s tests/sync -p 'test_*.py'` before implementation; confirm missing CLI failure.

## Task 2 — Sync CLI and compatibility entry point

- [x] Implement `scripts/sync-ai-pilot.py` with status/import/bootstrap/export/continue operations.
- [x] Run Git only with argv lists; validate refs/prefixes and keep branch operations in scratch clones.
- [x] Persist operation records and halt on merge conflict without modifying original repositories.
- [x] Replace `scripts/sync-to-gp.sh` with a preview-first export wrapper.
- [x] Run the temporary-repository regression suite and fix failures.

## Task 3 — Documentation and live read-only verification

- [x] Document direction, initial baseline establishment, SHA tracking, conflicts and reviewed PR publication in README.
- [x] Add the spec/plan to the Git ignore exceptions.
- [x] Run status against the current personal and team clones, reporting outstanding working-tree changes.
- [x] Request independent code review and verify actionable changes.
- [x] Record test results and remaining live initialization requirements; do not claim remote publication.

## Verification — 2026-11-10

- 13 executable Git integration tests passed. Includes repeated round trips,
  subtree export conflict/continue, outside-prefix protection, ignored local
  files, dirty inputs, nested workspace rejection and aborted/replaced history.
- Independent review reproduced a continuation history-loss bug; a regression
  test failed before the fix. Continuation now requires pre-conflict ancestry,
  and final results require both selected source and team ancestry.
- Shell wrapper syntax and preview verified; `git diff --check` passed.
- Initial live read-only status: source `4721fc1`, team `fcde4ef`; both dirty and
  committed trees unequal. Source has uncommitted workflow/skill/sync work. Team
  has untracked local files elsewhere in the monorepo. No live initialization,
  original-checkout commits, remote fetches or pushes were performed.
- Live bootstrap requires clean committed inputs and reviewed baseline conflicts.
  Integrate results with merge history retained; do not squash sync PRs.

## Local synchronization preparation — 2026-11-10

The standalone workflow, shared skill and sync-tool changes are organized into
three local commits. Private `.mcp.json` and Playwright captures remain on disk
and are excluded locally rather than published. Team untracked work outside
`mcp/ai-pilot` remains in its original checkout; a separate clone of its committed
branch is prepared as a clean synchronization input. This preparation performs
no remote fetch, bootstrap, import, export or push.
