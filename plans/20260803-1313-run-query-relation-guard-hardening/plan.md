---
title: "run_query relation guard — schema boundary, metadata block, sensitive-table denylist"
description: "Parse every run_query statement with the real Postgres parser and reject relations outside the token's schema caps, the catalog, or the per-datasource denied-table list."
status: completed
priority: P1
effort: 8h
branch: main
tags: [security, pg-connection-pool, guardrails, mcp, parser]
created: 2026-08-03
completed: 2026-08-03
---

# Plan — `run_query` relation guard hardening

**Created:** 2026-08-03 13:13 +07 · **Project:** `pg-connection-pool` (standalone repo, workspace conventions apply)
**Source of truth:** [brainstorm report](../reports/brainstorm-260803-run-query-relation-guard-hardening.md) (design agreed — do not redesign)
**Predecessor:** [20260730-1356 statement-guard plan](../20260730-1356-run_query-statement-guard-security-enhancement/plan.md) — fully completed; this plan extends the same choke point.

## Goal

The gateway's read-only guarantee holds; **what** can be read does not. Token `schemas` caps gate only the declared `schema` param, `information_schema`/`pg_catalog`/`SHOW` are wide open in `run_query`, and identity tables (`user`, sessions, `*_access_controls`) are fully readable under `pg_read_all_data`.

Add a **relation guard** at `QueryService.run()` (after `assertSingleStatement` + `assertStatementAllowed`, before any DB contact) that parses the statement with the **real Postgres parser** (`libpg-query`) and rejects, per referenced relation: system-catalog schemas, schemas outside the token's caps, implicit `pg_%` catalog names, and per-datasource **denied tables**. Parse failure = reject (fail-closed). Decoded parser identifiers also close the documented `U&"\0070g_read_file"` unicode-escape bypass.

## Phases

| # | Phase | Status | File |
|---|-------|--------|------|
| 01 | Parser dependency + relation/function extraction (CTE-aware walk) | ✅ Done | [phase-01](phase-01-parser-and-relation-extraction.md) |
| 02 | Relation policy + `DS_<NAME>_DENIED_TABLES` config + 403 error type | ✅ Done | [phase-02](phase-02-relation-policy-and-config.md) |
| 03 | Wiring: `QueryService.run()`, internal trusted path, boot log, `SHOW` removal | ✅ Done | [phase-03](phase-03-query-service-wiring-and-internal-path.md) |
| 04 | Tests (extraction, policy, transports, internal-flag unreachability, regressions) | ✅ Done | [phase-04](phase-04-tests.md) |
| 05 | Docs / `.env.example` / README / risk + runbook sync + user-action callouts | ✅ Done | [phase-05](phase-05-docs-and-env-sync.md) |

**Dependency order:** 01 → 02 → 03 → 04. Phase 05 may start after 03. **Strictly sequential — no parallel execution:** 01/02/03 each touch `src/query/relation-guard.ts` or `statement-guard.ts`.

## Key dependencies

- **New runtime dep:** `libpg-query@pg18` (18.1.4) — WASM-only, dual ESM/CJS, no native toolchain. Matches `docker-compose.yml` `postgres:18-alpine`.
- Existing: `assertSingleStatement` + `assertStatementAllowed` stay always-first and unchanged in role.
- `caps.schemas` must reach `QueryService.run()` — transports **do** need a one-line change each (see Phase 03 note).
- `IntrospectService` **and** the boot posture probe both run catalog SQL through `run()` → both need the internal trusted path or they break.

## Key invariants (do not break)

- Guard inspects **only `input.sql`**; internal `BEGIN`/`SET LOCAL`/`COMMIT`/`DISCARD ALL` execs are untouched.
- `assertSingleStatement` stays first and always-on; the relation guard is the third layer, still **pre-DB-contact**.
- Fail-closed everywhere: unparseable SQL rejects; missing `allowedSchemas` means "declared schema only"; the internal trust flag is a **second positional argument**, never a field a request body could carry.
- `allowUnsafeStatements=true` skips the relation guard too (operator escape hatch, boot WARN).
- Still defense-in-depth: the DB role remains `pg_read_all_data`; explicit-grants runbook stays the durable fix.
- **No DDL/migrations by the agent** (`.claude/rules/no-migrations-rule.md`) — dropping `env_dump`/`pg_rce_out` is a user action.

## Success criteria (whole plan — from the brainstorm)

- `run_query`: `information_schema.tables`, `pg_tables` (unqualified), `pg_catalog.pg_roles`, `SHOW all` → 400 + audit entry.
- `SELECT * FROM "other-schema".t` under a schema-restricted token → 403-class rejection.
- `SELECT * FROM "user"` / `public."user"` / unicode-escaped variant → 400 denied-table.
- CTEs, joins, subqueries, EXPLAIN, VALUES over allowed tenant tables → unchanged behavior.
- `list_schemas` / `list_tables` / `describe_table` still work (internal trusted path).
- All existing guard tests green; new unit tests for relation extraction incl. quoted + unicode-escaped identifiers.
- Added by review of live code: boot posture probe still reports OK/WEAK (not UNVERIFIED) — it queries `pg_roles`/`pg_class` through the same choke point.

## Completion note (2026-08-03)

**Shipped on `main`** (pg-connection-pool is its own git repo — a stale memory note said "not under git"; corrected). All 5 phases done.

**Source touched**
- Created: `src/query/banned-functions.ts` (shared banned-fn list), `src/query/relation-guard.ts` (extraction + policy), `test/relation-guard.test.ts`.
- Modified: `src/query/statement-guard.ts` (consume shared list; `SHOW` removed; header note), `src/query/gateway-errors.ts` (`ForbiddenError` 403), `src/auth/token-auth.ts` (`capabilityAllows` exported + rewired), `src/query/query-service.ts` (guard block + `allowedSchemas` + `InternalTrust` 2nd positional arg), `src/routes/query.route.ts` + `src/mcp/tools.ts` (`allowedSchemas: caps.schemas` + tool desc), `src/introspect/introspect-service.ts` (internal path ×3 + `visibleSchema`→`isSystemSchema`), `src/boot/assert-readonly-posture.ts` (internal path + parser warm-up + per-ds guard log), `src/config/config.schema.ts` + `src/config/load-config.ts` (`deniedTables`), `test/helpers.ts`.
- Tests extended: `query-service`, `routes.e2e`, `mcp-tools`, `statement-guard` (SHOW flip), `load-config`, `integration/pg` (3 guarded cases, skip w/o live PG).
- Docs: `README.md`, `.env.example`, risk report, runbook, journal, `../../docs/design-notes/pg-connection-pool-query-gateway.md`, root `../../CLAUDE.md`, brainstorm marked implemented.

**Dependency:** `libpg-query@^18.1.4` (WASM, dual ESM/CJS; verified stdout-silent for MCP stdio). `package.json` + `package-lock.json` committed.

**Tests:** `196 tests / 181 pass / 0 fail / 15 skipped` (typecheck clean). Baseline was 148/136/12. NB: in a network-restricted sandbox, `bind-guard.ts`'s one `listen()` test fails on `EPERM` — a sandbox artifact, green when run normally.

**Post-implementation code review — 1 CRITICAL found & fixed:** the `code-reviewer` agent (verified against the real parser) caught that `libpg-query` emits INSERT/UPDATE/DELETE/MERGE `.relation` and `SELECT … INTO`'s `.intoClause.rel` as **bare, untagged** RangeVars, so the original `walk()` (`key === 'RangeVar'` only) collected **zero** relations from write/create targets — a fail-open hole letting a write-mode token write cross-tenant or to a denied table. **Fixed** in `relation-guard.ts`: `walk()` now also collects a bare RangeVar (`typeof obj.relname === 'string'`) **unconditionally** (no CTE-scope skip — you cannot write into a CTE), via a shared `pushRelation`. Read-path relations stay wrapped in `{ RangeVar: … }` so they keep the scope-aware branch and are never double-counted. Added write-path regression tests (extraction of all 5 target kinds incl. CTE-named target; policy 400/403 on denied/cross-schema targets; two `query-service` write-path tests asserting `connectCount === 0`). README relation-guard section updated to state write/create targets are policed. Re-verified: 196/181/0/15, typecheck clean.

**Reconciliation (plan assumption vs live parser):** pg18's `libpg-query` **accepts** bare `SELECT` (empty SelectStmt, no relations — harmless), so the "invalid `SELECT` → throws" fixture in phase-01/02/04 was changed to `SELECT * FROM` (which does throw). No behaviour impact — a bare `SELECT` has no relations to police and the DB rejects it anyway.

**Context-doc impact:** none — this repo has no `*_AI_CONTEXT.md` / `*_ARCHITECTURE.md` (README + the workspace design note are authoritative; both updated).

**⚠️ USER-ONLY follow-ups (agent must NOT run — `.claude/rules/no-migrations-rule.md`):**
1. **Add the deny list to the live `.env`** — paste `DS_MAIN_DENIED_TABLES=…` from `.env.example` and restart / reconnect MCP. Until then the code default is empty → **no table is denied**.
2. **Drop the RCE-PoC leftovers** — `DROP TABLE IF EXISTS public.env_dump; DROP TABLE IF EXISTS public.pg_rce_out;` (deny list only hides them; the shared role can still read them).
3. **Rotate secrets** in the gateway/DB host env at PoC time (DB password, bearer + `MCP_TOKEN`, app secrets).

**Deferred (not this plan):** explicit-grants runbook to drop `pg_read_all_data` (approach C); optional advisory async audit flag if the audit stream ever reveals a semantic gap the parser cannot see.
