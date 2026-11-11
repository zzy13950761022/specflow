# Dashboard-driven Codex execution

The user approved implementation on a new branch after discussing service-owned
workflow orchestration. Dashboard remains the interaction surface for creation
and review. Local Codex is an execution runtime; VS Code plugin attachment is
outside this implementation because its public session interface is unverified.

## Execution and state

AppCore persists canonical state and artifacts in the registered repository.
An optional automation object in each ticket is the durable execution queue:
enabled, status, attempt, run ID, owner/runner PIDs, thread ID and worktree path.
The orchestrator reads this state at startup and on events, serializes each ticket
and limits total concurrency. Events are advisory and deduplicated. Monotonic state versions compare-and-set
reconciliation updates across independent controllers. Notifications
received during a run remain queued for subsequent reconciliation.

A run token fences model output and workflow writes. Read-only artifact turns and
workspace-write implementation turns each return one structured result. The host
owns plan registration, claims, logs, completion, platform checks and advancement.
Checks precede result generation and execute in the ticket's worktree. Waiting
review has no active model turn or approval-polling call.

## Review

The plan review authorizes implementation, not entry to TEST. After implementation
finishes, every task receives an immutable report with source snapshots, available
tracked diff and current logs. Each review binds plan revision, task attempt and
the worktree source fingerprint. Dashboard approves a loaded review ID. Revision
or rejection resets the affected task/dependents and archives the verdict; source
or exclusion-policy changes require new review. Completed historical workflows
remain completed and are not automatically migrated into new execution.

Review endpoints require a memory-only Dashboard browser capability and reject
cross-origin writes. Managed runs have network disabled, isolated Codex user
configuration, and no approval MCP capability. Repository Codex MCP/hook
configurations are refused. This is a managed execution and browser boundary,
not proof of human identity against unrestricted same-user local programs.

## Workspace and recovery

Each ticket gets a deterministic Git worktree and branch. Creation requires clean
committed source; reuse verifies Git identity and never resets existing work.
Canonical workflow files stay outside the writable worktree. Host checks read
their command configuration from the registered repo, never the agent-writable
worktree copy; command configuration is also bound to the source fingerprint. Checks and
fingerprints use its source, and dependencies require explicit preparation.

Pause fences late output and requests cancellation. The entire owned POSIX process group is terminated and checked
before permitting another run. Existing platform checks may finish. A dead owner
marks interrupted work failed; a live child prevents retry. Failures require
Dashboard inspection/retry and preserve partial code, claims and thread state.

## Validation

Domain tests cover review gating, source drift and revision reset. Scheduler tests
cover persistence, duplicate notifications, pause and launch failure. A subprocess
protocol fixture covers JSON-RPC, cancellation and malformed output. An integration
test drives creation, plan approval, implementation approval and actual worktree
checks. Browser tests validate the existing review surface. Real model execution
and VS Code plugin visibility are reported separately from these checks.
