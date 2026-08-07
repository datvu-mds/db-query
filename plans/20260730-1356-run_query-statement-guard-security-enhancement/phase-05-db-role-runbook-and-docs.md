# Phase 05 — DB-role runbook + docs (PRIMARY fix, human action)

## Context Links
- Plan: [plan.md](plan.md)
- Risk report: [../../docs/risks/2026-07-29-mcp-run_query-write-and-rce-bypass.md](../../docs/risks/2026-07-29-mcp-run_query-write-and-rce-bypass.md)
- Boot posture: `src/boot/assert-readonly-posture.ts` · README, `.env.example`
- Rule: `.claude/rules/no-migrations-rule.md` — **the agent must NOT run role/DDL SQL.**

## Overview
- **Priority:** P0 for the *real* guarantee (the code guard is only defense-in-depth).
- **Status:** ✅ Done. **Independent of phases 01–04.**
- **Description:** Document the non-superuser role remediation as a copy-paste runbook for a human DBA, record it in the risk report, and keep the docs the codebase relies on in sync. **No SQL is executed by the agent.**

## Key Insights
- The single durable fix is: stop connecting as superuser `mds_dev`; use a `pg_read_all_data`, non-superuser role. That role *cannot* use `COPY … TO PROGRAM/'file'`, `pg_read_file`/`pg_ls_dir`, `pg_reload_conf`, others' `pg_terminate_backend`, `pg_logical_emit_message`, `CREATE EXTENSION`, or untrusted-language `DO` — closing C-1…C-4, M-1/M-2, and H-1…H-3 at the root.
- The boot probe already exists to verify this; the runbook's acceptance test is simply "boot log prints `read-only posture OK`, not WEAK".

## Requirements
- A runbook section (human-run SQL) — verbatim from the report's Fix #1, with the acceptance check.
- Risk-report status update: mark Fix #2 (guard) + escape hatch as implemented once phases 01–04 land; Fix #1 remains **pending human action**.
- README: document the statement guard, the `DS_<NAME>_ALLOW_UNSAFE_STATEMENTS` flag, and the role runbook pointer.
- AI-context-docs sync per `.claude/rules/ai-context-docs-sync.md` (state impact explicitly).

## Runbook (human DBA — do NOT run via agent)
```sql
-- 1. Create a non-superuser, read-only role
CREATE ROLE agent_ro_pg WITH LOGIN PASSWORD '<32+ char random>';
GRANT pg_read_all_data TO agent_ro_pg;
ALTER ROLE agent_ro_pg SET default_transaction_read_only = on;
REVOKE TEMP, CREATE ON DATABASE mds_dev FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```
Then: set `DS_MDS_MAIN_USER=agent_ro_pg` (+ new password) in `.env`, restart, and **confirm the boot log prints `read-only posture OK`** (not WEAK/UNVERIFIED). Rotate the weak `mds_dev` password regardless. Leave `DS_MDS_MAIN_ALLOW_UNSAFE_STATEMENTS` **unset** (guard enforced) for this datasource.

## Related Code Files / Docs
- **Modify:** `README.md`, `.env.example`, `docs/risks/2026-07-29-mcp-run_query-write-and-rce-bypass.md` (status), any `*_AI_CONTEXT.md`/architecture doc describing the query path.
- **Create (optional):** `docs/runbooks/agent-ro-pg-role.md` (extract of the runbook above).

## Implementation Steps
1. Write the runbook doc (or inline README section) — clearly flagged as human-only.
2. Update the risk report: Fix #2 + escape hatch → *implemented*; Fix #1 → *pending human action*; note the new guard files.
3. README: statement-guard behavior, allowlist, escape-hatch flag + caveat, runbook link.
4. AI-context sync: update or explicitly state `Context-doc impact: none` if no `*_AI_CONTEXT.md` covers this module.

## Todo List
- [x] Runbook doc (human-only, no agent execution)
- [x] Risk-report status updated
- [x] README: guard + flag + runbook link
- [x] `.env.example`: `DS_<NAME>_ALLOW_UNSAFE_STATEMENTS` with caveat
- [x] AI-context sync statement recorded

## Success Criteria
- A DBA can execute the runbook and see `read-only posture OK` at boot.
- Docs describe the guard, the escape hatch, and the role fix consistently; no doc claims behavior the code lacks.

## Risk Assessment
- **Agent accidentally runs the SQL** → explicitly forbidden by `.claude/rules/no-migrations-rule.md`; the doc is prose + fenced SQL only, never a command to execute.
- **Password in `.env`** → keep out of git (`.gitignore`), rotate the old weak one.

## Security Considerations
- This phase delivers the *actual* guarantee; phases 01–04 are the belt to its braces. Do not present the guard as a substitute for the role fix.

## Next Steps (documented follow-ups, out of current scope)
- M-3: boot WARN for `schemas:['*']` / `datasources:['*']` tokens; scope the deployed token to explicit lists.
- Append-only external audit sink + DB-side `log_statement='all'`/pgaudit under a role the gateway can't control.
- Remove unused `dblink`/`postgres_fdw`/`plpython3u`/`plperlu`/`file_fdw` `.so`s from the DB image (defuses H-3).
