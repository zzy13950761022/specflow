# Specflow skill validation — 2026-11-10

The baseline used the original Claude-only Specflow skill. Independent read-only
simulations then applied the repository skill to the same seven scenarios in
`specflow-scenarios.json`. No simulated call was executed against live tickets.

| Scenario | Baseline finding | Updated decision |
|---|---|---|
| Approved DEVELOP plan | No claim protocol; toggle and repeat artifact submission | Claim ready work, log it, complete idempotently; retain the approved plan |
| Failed check with passing AI summary | No platform-check action; may keep polling | Diagnose actual evidence and rerun only after fixing the cause |
| Completed legacy ticket | No terminal completion branch | Report completion; no regeneration or advance |
| Paused status request | No pause branch | Report state and do not resume or execute |
| Documentation with no repo templates | Fixed eight stages, forced templates and guessed spec path | Documentation template, built-in prompts, platform-owned path |
| Interrupted claimed work | No current-attempt/claim-aware reconciliation | Verify ownership and implementation, match current log, then complete without duplicate work |
| TEST drift while at BUILD | No upstream evidence invalidation branch | Reopen TEST before proceeding with BUILD |

The updated skill produced appropriate decisions in all seven simulations. When
fixtures omit repository mapping, claim ownership, configuration, or verification
results, the evaluator requested reads and kept subsequent actions conditional
rather than inventing missing data.

Evaluation also found stale MCP wording about nonempty artifacts and toggling
completion. The tool descriptions and empty-implementation error were aligned
with existing validation: file-only changes are accepted when changed/created
files are recorded; completely empty implementations remain rejected.

Additional validation:

- Skill Creator frontmatter validation passed.
- Four installer tests passed: backup and idempotency, existing shared skill
  preservation, source/target cycle rejection, and failure rollback.
- MCP tool contract tests passed (24 tests); relevant AppCore tests passed.
- Production build passed. A stdio handshake verified all operations used by
  the skill are exposed and the updated implementation-log guidance is present.
- Both installed user-level links resolve to the same maintained repository
  directory. The original Claude skill was backed up outside discovery paths.

These simulations validate decision guidance, not live deployment, human approval,
or autonomous agent launch. Client session reload is still needed to discover a
newly installed skill.
