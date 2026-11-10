# SAP extensibility plugin-service conventions

Read only when the target is the SAP cxmc-extensibility-plugin-service repository.
Confirm these conventions against its current AGENTS.md/CLAUDE.md, curated prompts,
and existing files before implementing changes. They are not AI Pilot defaults.

- CDS entities/types: `db/plugin.cds`; service/actions: `srv/plugin-service.cds`.
- Generated source: `srv/src/gen/`; modify source models rather than generated files.
- Handler package: `com.sap.cx.commerce.extensibility.plugin.handlers`.
- Tests live under `srv/src/test/java/.../handlers/` in this repository, including
  Spock files. Follow existing `<ClassName>Test.groovy` naming. Use Karate where the
  repository's integration test setup calls for it.
- New Java files follow the repository's SAP copyright header and trailing-newline
  conventions. Preserve existing notices.
- Sanitize line breaks in untrusted logged values; do not include tenant/account
  identifiers, email addresses, usernames, or other PII in logs.
- Existing status-violation errors use `BAD_REQUEST` (400); follow the local error
  catalog and API contract. This domain convention does not change AI Pilot REST errors.

Inspect the actual Maven/reporting setup for TEST/BUILD. A shell Maven run and an
AI coverage metric do not issue Specflow evidence. Configure `run_stage_check` for
the repository; if coverage is produced as JaCoCo, use a reviewed fresh-report
conversion to the platform's supported Istanbul coverage-summary line totals.
Do not make up an npm coverage command or claim raw JaCoCo XML is accepted.
