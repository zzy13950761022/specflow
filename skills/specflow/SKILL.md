---
name: specflow
description: >-
  Use when the user requests AI Pilot/Specflow to create, execute, resume, or rework
  a ticket workflow, asks for its next step, or invokes /specflow or $specflow.
  Applies to standard features, bug fixes, and documentation workflows managed
  by the AI Pilot MCP server.
---

# Specflow

Use AI Pilot's persisted workflow state to drive work through reviewed stages.
Read state before deciding what to do; approval, implementation, and advancement
are separate operations. The same instructions apply to Claude Code and Codex.

## Managed Dashboard execution

When the host explicitly supplies an **AI Pilot managed execution** contract,
perform only its supplied artifact or claimed implementation task. Return the
requested structured result and end the turn. The host calls AppCore for
submission, claims, implementation logging, checks and stage advancement; MCP
tools are intentionally absent in this mode. Do not run the interactive loop,
poll approval, self-approve, or ask the user to type a continuation message.
Read repository instructions and use the supplied approved context. Artifact
turns are read-only; implementation turns write only in their assigned worktree.
Human decisions stay in Dashboard, including completed-subtask review before
TEST. A workflow decision does not authorize command escalation or deployment.

## Connect and identify the ticket

1. Discover the AI Pilot MCP tools exposed in this session and inspect their input
   schemas. Operation names below are MCP operation labels; map them to the actual
   callable names. Do not assume a client-specific namespace. If required tools
   are missing, report which capability is unavailable and the client setup or
   reload needed. Do not substitute JSON edits, direct AppCore calls, or invented
   tool results for platform operations.
2. Resolve the user's target repository, using the current Git root when none is
   specified. Match its resolved path to `list_repos`; use that entry's `id`. Never
   hardcode a repository ID. If it is not registered, ask the user to add it in
   Dashboard; do not silently choose a different repository.
3. Extract the ticket ID and feature description; ask once if the ID is missing.
   Check `list_specs`/`get_spec` before creating anything. For an existing ticket,
   keep its template and plan and read `get_execution_status`.
4. For a new ticket, use `create_spec` with the requested `workflowKind`: standard
   by default, bugfix for an explicitly requested bugfix workflow, documentation
   for an explicitly requested documentation-only workflow. Keep `risk=normal`
   and `autoChecks=false` unless the user selects otherwise.
5. `templateStatus=none` means built-in prompts are available. Proceed to
   `get_stage_prompt`; generate repository templates only when requested.

Read the target repository's AGENTS.md/CLAUDE.md and curated stage prompts. For
the SAP extensibility plugin-service repository, also read
[references/plugin-service.md](references/plugin-service.md). These conventions
do not apply to AI Pilot's own TypeScript repository or unrelated projects.

## Follow execution state

Use `get_execution_status` and its structured `actions`, refreshed after mutations,
as the next-step guide. Combine each action with the current spec, user request,
and tool schema; action objects are hints, not complete tool arguments.

| State or condition | Action |
|---|---|
| `completed` | Report completion and stop. No additional advance or regeneration. Historical `legacyCompletion` tickets also stay completed. |
| `paused` | Report pause and stop execution. Call `resume_execution` only when the user requests continuation/resumption. |
| Interrupted check or `failed` | Inspect the error and evidence output. Correct the cause; explicitly recover/retry when authorized. Do not repeat unsuccessful commands without a change. |
| Active check | Read status and let the check finish; do not start another check or change its artifact revision. |
| `get_stage_prompt` | Generate the current stage artifact using its prompt and approved context, then submit it. |
| `get_approval_status` | Wait for review of the submitted revision using a bounded call. |
| `claim_subtask` / `log_implementation` | Execute the approved development plan as described below. |
| `submit_implementation_review` | Submit completed implementation reports for Dashboard review. |
| `get_implementation_review` | Read the indicated subtask report; yield while human review is pending. |
| `run_stage_check` | Run the configured platform check and inspect its evidence. |
| `reopen_stage` | Reopen the returned stage with a concrete reason, then redo affected stages in order. The target can precede the current stage. |
| `advance_stage` | Advance the current approved and complete stage, then read the new state. |

For a status-only request, return findings and the next step without starting work,
resuming, or changing state. Empty actions are not permission to advance. When
the actions and user intent cannot be reconciled, report the specific blocker.

Pause prevents new platform execution; it does not terminate commands already
running or stop an external agent editing files. Do not promise an immediate kill.
An existing approval, task completion, or passed check should not be replayed just
because a session restarted. Recover interrupted checks with `resume_execution`,
which does not automatically rerun them or release live claims.

## Generate, submit, and review

- Obtain `get_stage_prompt`. It includes approved upstream snapshots and valid
  implementation logs; use `get_stage_context` for structured access. Required
  missing or stale inputs are blockers, not a reason to invent context.
- Submit artifacts through `record_ai_output`. The platform owns canonical paths
  and immutable history; use `specPath` and returned artifact paths. Do not write
  the canonical spec manually to a guessed `specs/` path.
- For SPEC, capture scope and acceptance criteria with stable IDs and nonempty
  `given`, `when`, `then` fields. For documentation workflows, make the documentation
  scope explicit.
- For REQUIREMENTS, supply `requirementsData` when structured analysis helps. For
  DEPLOY, use `checklistItems` and rollback criteria. For OPS, set `logsSanitized`
  truthfully after reviewing the report. Use only fields the tool schema supports.
- A pending or approved artifact cannot be silently replaced. After rejection or
  a revision request, address `gate.comment` and resubmit the current stage. To
  change previously approved work, use explicit rework.
- After submission, read execution actions: optional low-risk policy approval may
  already have approved TEST/BUILD. Otherwise call `get_approval_status` with
  `waitMs=30000` (maximum 60000; 0 for a snapshot). After two unchanged timeout
  responses, report the pending stage/revision and yield unless the user requested
  continued monitoring. Do not busy-loop or claim that one call waits indefinitely.
- Human review happens in Dashboard and is bound to the reviewed revision. Do not
  self-approve on the user's behalf. After a decision, reread state before acting.

Skip stages marked `skipped` by the selected template. Do not manufacture approvals
or run a fixed eight-stage loop. DEPLOY/OPS artifacts do not authorize pushing,
publishing, sending notifications, or deploying; perform external actions only
within the user's explicit authorization.

## DEVELOP: approved plan, then implementation

Before coding, register a nonempty plan with `set_develop_subtasks`: use stable IDs,
descriptions, `dependsOn`, and repository-relative `files` declarations. Link each
task to one acceptance criterion ID using `requirementRef`; use `testRefs` for
planned/actual tests. Register referenced criteria in SPEC first. Submit the plan
with `record_ai_output` and wait for its current revision to be approved. Changing
the task list invalidates plan approval.

After plan approval, implement outstanding tasks; do not immediately advance or
submit another DEVELOP artifact. For each task:

1. Read the current spec and task. Skip completed tasks. Claim a ready pending task
   with `claim_subtask`; obtain `claimId` from that task in the returned spec.
   Dependencies must be complete and declared files must not conflict with running
   tasks. Work sequentially unless parallel agent execution is authorized.
2. For a running claim from a resumed session, establish that it belongs to this
   work before using it. Do not take over another agent's active work. Read
   `get_implementation_logs` when reconciling interrupted work: raw logs include
   history, so only matching `subtaskId`, `developRevision`, and `taskAttempt` count.
3. Implement and verify the claimed work using ordinary code tools. Record
   `log_implementation` with the current `claimId`, actual changed/created files,
   summary, statistics, and relevant artifacts. Describe what was actually built.
   File-only changes may use an empty artifacts object when changed files are
   recorded; an entirely empty implementation is invalid.
4. Call `set_subtask_completed` with `completed=true` and the current `claimId`.
   Prefer this idempotent operation over `toggle_subtask`. If the same claim already
   has a current revision/attempt log and the implementation is verified, complete
   it without rewriting code or duplicating its log. Reconcile ambiguous tool
   timeouts by rereading state before retrying.
5. If work is abandoned or must be retried, use `release_subtask` with its claimId,
   then claim again. A new attempt needs a new log. Release affected running
   dependents before resetting upstream completion or changing the plan.

When every task is complete and validly logged, submit implementation review and
wait for each current subtask report to receive human approval in Dashboard.
Completion does not authorize entering TEST. Review tokens bind plan revision,
task attempt and source fingerprint; code changes require fresh review. Address
implementation revision comments from task review history and redo affected
tasks using their new attempt. Follow `advance_stage` only after valid approvals. Keep the
approved plan artifact intact; implementation logs provide the completion record.
Use `get_traceability` before integration review to find missing requirement/file/
test links. Do not invent references to make the traceability report look complete.

## TEST and BUILD: platform evidence

Read `.specflow/checks.json` and the current tool schema. Run `run_stage_check` for
the current TEST/BUILD stage. It executes configured argv and persists actual exit
code, output, coverage, timing, and a source fingerprint. Ordinary shell checks
may help diagnose failures, but do not satisfy the platform gate.

TEST requires exit 0 and actual Istanbul coverage-summary `total.lines` coverage
of at least 80%; BUILD requires exit 0. The test report must be a fresh JSON file
under repository `coverage/`, without symlink traversal. Missing configuration or
unsupported reports (for example raw JaCoCo XML) need a repository-specific check
configuration/converter that emits actual measured line totals in the supported
format. Do not invent coverage or substitute test-pass rate for line coverage.

Inspect evidence before proceeding. Failure, timeout, truncated output, missing
coverage, or source drift blocks approval/advance. AI metrics are descriptive only;
`buildSuccess=true` cannot satisfy BUILD. Repository checks cannot overlap across
tickets. On a busy check, wait/read status rather than launching a competing one.

Submit an accurate result artifact after checking evidence, unless the current
artifact is already pending/approved. A pending result may have its check rerun
without resubmission; request revision/rework if its text needs changing. Approved
results require rework before a new check. After code changes, follow the earliest
invalid evidence action: at BUILD, stale TEST evidence requires reopening TEST.

## Rework

For a requested scope change or a recovery action, use `reopen_stage` with the
reached target stage and a specific reason. It preserves historical artifacts and
approvals but invalidates affected downstream work, task completion, and evidence.
Never reuse stale outputs as approved inputs or patch JSON to restore approval.
Finish/recover affected checks and explicitly release affected task claims first.
Resume from the returned current stage. Already completed legacy tickets enter
rework only for an actual requested change; do not migrate or regenerate them merely
to replace their historical evidence with new checks.
