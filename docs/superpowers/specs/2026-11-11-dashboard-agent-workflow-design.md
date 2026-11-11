# Dashboard Agent workflow design

Approved on 2026-11-11. Extends the Dashboard orchestration exploration at
`8d58188` with personal Agent profiles and a complete browser workflow.

## User experience

- Create Spec opens a labelled, keyboard-accessible modal. Repository, ticket,
  title, description, workflow, risk and execution mode are collected together;
  failed submissions retain input. Managed creation selects a saved Agent profile.
- The board replaces the inline creation form with ticket/title search, status,
  stage and workflow filters, sorting and result counts. URL parameters preserve
  the view across ticket navigation.
- Agent settings beside Add repo manages named Codex, Claude Code and OpenCode
  profiles, a user default and repository defaults. Local detection and a small
  real connection test distinguish executable availability from model access.
- Every stage offers canonical Specflow context to copy, explicit IDE handoff
  and Dashboard resume. Copy alone never transfers execution ownership.

## Configuration and execution

Users may share a Hyperspace service while selecting different native Agents,
providers and models. Preserve each native protocol through adapters: Codex App
Server, Claude structured print and OpenCode standalone JSON execution. Profiles
can inherit selected native transport settings or override command, config path,
provider, model, base URL and credential environment-variable name. Settings live
outside repository source; credential values never enter profiles or tickets.

Versioned profile snapshots keep existing tickets stable when defaults change.
Ordinary approvals/retries reuse the ticket session; explicit profile replacement
and return from IDE work start a fresh session from canonical state. Native
session IDs are not portable between Agents or automatically attached to IDE chats.

AppCore remains authoritative for artifacts, reviews, task claims and check
evidence. Creating a managed ticket atomically persists its queue state. Dashboard
starts reconciliation by default; `--no-runner` opts out. Approve/revise/reject
records the human decision before waking a bounded Agent turn. Agents end at
review gates rather than polling for approval. Current implementation reports
require human approval before platform-owned TEST and BUILD commands can run.

Codex implementation turns use native workspace-write access. Claude/OpenCode
read the workspace and return complete file changes; the host validates paths,
symlinks, protected metadata, source drift and the active attempt before applying
them. These adapters do not execute implementation shell commands. Repository
dependencies and configured checks must be available in the ticket worktree.

## Ownership and failure handling

Dashboard owns at most one active managed run per ticket. Handoff fences late
results, cancels execution and waits for the owned process before releasing IDE
ownership. Active checks prevent transfer. Resume rejects active external claims
or checks and reconstructs context from durable state and the actual worktree.
Partial work and history survive failures; retry is explicit. Configuration and
ownership routes require the existing browser review capability.

## Validation boundaries

Unit/integration coverage exercises settings revisions, native configuration,
session resume, cancellation, malformed results, source-change validation,
human gates and ownership. Browser coverage exercises creation, filters,
configuration, review and handoff, including retained input and modal scrolling.
Real minimal model calls were successful for all three installed Agents using
the user's native configuration. Full workflow programming was verified with
simulated Agent subprocesses, not three full real-model ticket runs.

See the [implementation plan](../plans/2026-11-11-dashboard-agent-workflow.md)
for the completed validation record, and README for startup and operational details.
