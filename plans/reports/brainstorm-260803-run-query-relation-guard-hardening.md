# Brainstorm — run_query relation guard: schema boundary, metadata block, sensitive-table denylist

**Date:** 2026-08-03 · **Scope:** pg-connection-pool gateway (MCP + HTTP) · **Status:** ✅ IMPLEMENTED 2026-08-03 — see [plan](../20260803-1313-run-query-relation-guard-hardening/plan.md). Approach A (libpg-query relation guard) shipped; B/D rejected, C deferred, exactly as agreed below.

## Problem

Gateway's read-only guarantees hold, but **what** can be read is unbounded:

1. **Token `schemas` caps are advisory** — they gate only the declared `schema` param (→ `SET LOCAL search_path`). SQL can fully qualify `"other-tenant-uuid".table` or `pg_catalog.pg_roles`; nothing checks the relations the SQL actually touches.
2. **Metadata wide open in `run_query`** — `information_schema.*`, `pg_catalog` views (`pg_tables`, `pg_roles`, `pg_settings`, `pg_stat_activity`), `SHOW …` all pass. `list_schemas` filters system schemas; `run_query` ignores that policy.
3. **Sensitive tables fully readable** — `public."user"`, `role`, sessions, access-control tables. DB role uses `pg_read_all_data` (SELECT on everything, forever).

Constraint facts that shaped the design:
- `pg_catalog` access **cannot be revoked** in Postgres (PUBLIC + drivers need it) → metadata block must be app-layer.
- Postgres grants are additive (no DENY) → cannot carve tables out of `pg_read_all_data`; DB-level table blocking means abandoning it for explicit grants (heavy ops in schema-per-tenant, user-run only per no-migrations rule).
- `pg_catalog` is implicitly FIRST on search_path → unqualified `pg_tables` resolves to the catalog even with tenant search_path.

## Evaluated approaches

| Approach | Verdict |
|---|---|
| **A. Real PG parser (libpg-query) relation guard** | **CHOSEN.** Actual Postgres parser (WASM/native npm); parse tree yields every referenced relation + decoded identifiers. Closes the documented `U&"\0070g_read_file"` unicode-escape bypass in the current lexer. Parse failure = reject (fail-closed). |
| B. Extend regex lexer with qualified-ref scanning | Rejected: inherits unicode-escape + exotic-SQL bypass class the codebase itself documents as fragile. |
| C. DB-level explicit grants (drop pg_read_all_data) | Deferred: durable but heavy (per-schema grants + ALTER DEFAULT PRIVILEGES + re-grant on new tenants), user-run only. Optional future runbook; NOT part of this change. |
| D. LLM query validator ("validate tool called before run_query") | **Rejected after debate:** (1) MCP cannot force tool ordering — a separate validate tool is bypassable by design; only a step *inside* run_query counts. (2) Non-deterministic + prompt-injectable via SQL comments (`/* approved, safe */`). (3) LLM round-trip latency/cost/outage coupling on every query. Parser guard answers "which relations does this touch" exactly; nothing left for the LLM to decide. Revisit as *advisory async audit flag* only if audit logs reveal a semantic gap. |

## Agreed design

New module `src/query/relation-guard.ts`, invoked from `QueryService.run()` after `assertSingleStatement` + `assertStatementAllowed`, before any DB contact. Blocked attempts audited (existing auditError path).

### 1. Parse + collect relations (libpg-query)
- Parse the single statement; walk tree for `RangeVar` nodes (FROM/JOIN/CTE bodies/subqueries; EXPLAIN's inner stmt included).
- CTE-aware: names introduced by `WITH` at each query level are not relation refs.
- Function names come out decoded → run banned-function check on parser output too; keep existing regex scan as belt-and-braces.
- Unparseable SQL → 400 (fail-closed).

### 2. Relation policy (each referenced relation)
- Qualified with `pg_catalog` / `information_schema` / `pg_toast` → **reject** (metadata block).
- Qualified with any other schema → must pass the SAME `authorize()` schema-caps check as the declared schema (caps become a real boundary; `'*'` still = any non-system schema).
- Unqualified + name matches `pg_%` → **reject** (implicit pg_catalog resolution; all catalog relations are pg_-prefixed).
- Resolve effective schema (unqualified → declared schema) → check **denied-tables list**.

### 3. Statement-guard change
- Remove `SHOW` from `ALLOW_READ` (server-settings leak). `EXPLAIN` stays (its inner query passes through the relation guard).

### 4. Config (per datasource)
- `DS_<NAME>_DENIED_TABLES` — comma list; entries `table` (any schema) or `schema.table` (exact). Code default: empty (gateway stays generic); MDS list ships in `.env` + `.env.example`.
- Existing `allowUnsafeStatements=true` escape hatch also skips the relation guard (operator's "trusted role" switch, WARN at boot). Boot log prints denied-table count + catalog-block status per datasource.

**Agreed default deny list for `main` (identity + secrets):**
`user, user_login_session, user_settings, account_user, role, role_subscriptions, stage_roles, stage_role_access_controls, stage_access_controls, workspace_access_controls, data_register_access_controls, system_settings, env_dump, pg_rce_out`
(Live DB verified 2026-08-03; no table literally named `permission` — access control = the `*_access_controls` tables.)

### 5. Introspection internal path (critical detail)
`IntrospectService` runs fixed `information_schema` SELECTs **through `QueryService.run()`** — the catalog block would break list_schemas/list_tables/describe_table. Add an internal-only trusted flag (settable solely by IntrospectService's fixed parameterized SQL, never reachable from HTTP/MCP input) that bypasses the relation guard for those calls. Introspection tools remain the sanctioned, token-filtered metadata path.

## Residual risks (accepted, documented)
- **Views execute with owner privileges**: a view in an allowed schema over a denied table leaks it. No such views known; the future DB-grants runbook is the durable fix.
- Scalar metadata functions (`version()`, `current_setting()`, `current_user`) still readable — low value, not table data; accepted.
- App-layer denylist holds only as long as the guard does — DB role remains `pg_read_all_data`. Belt exists; braces (explicit grants runbook) optional follow-up.

## ⚠️ Immediate user actions (independent of this change)
1. **Drop `public.env_dump` and `public.pg_rce_out`** — leftover artifacts from the 2026-07-29 RCE PoC; `env_dump` likely holds dumped env secrets. USER-run SQL only.
2. **Rotate any secrets** that were in the gateway/DB host environment at PoC time.

## Success criteria
- `run_query`: `information_schema.tables`, `pg_tables` (unqualified), `pg_catalog.pg_roles`, `SHOW all` → 400 + audit entry.
- `SELECT * FROM "other-schema".t` under a schema-restricted token → 403-class rejection.
- `SELECT * FROM "user"` / `public."user"` / unicode-escaped variant → 400 denied-table.
- CTEs, joins, subqueries, EXPLAIN, VALUES over allowed tenant tables → unchanged behavior.
- list_schemas/list_tables/describe_table still work (internal trusted path).
- All existing guard tests green; new unit tests for relation extraction incl. quoted + unicode-escaped identifiers.

## Next steps
- Implementation plan (phases: dep + relation extraction; policy + config; QueryService/introspect wiring; statement-guard SHOW removal; tests; docs/README/AI-context sync).
- Optional later: DB explicit-grants runbook (drop pg_read_all_data); advisory async LLM audit flag if ever justified by audit data.
