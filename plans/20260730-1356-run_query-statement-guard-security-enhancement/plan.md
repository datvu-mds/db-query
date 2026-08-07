# Plan — `run_query` statement-guard security enhancement

**Created:** 2026-07-30 13:56 +07
**Owner project:** `pg-connection-pool` (standalone; workspace conventions apply)
**Driver:** [Risk report](../../docs/risks/2026-07-29-mcp-run_query-write-and-rce-bypass.md) — a read-only MCP token reached RCE + file R/W + persistent write via one `run_query`, because the DB role is superuser (defense layer #6 absent) and `BEGIN TRANSACTION READ ONLY` (layer #4) does not stop `COPY`, `pg_read_file`, signals, or WAL messages.

## Goal

Add the **defense-in-depth statement guard (report Fix #2)** at the single `QueryService.run()` choke point so a read-mode token cannot execute side-effecting statements/functions (`COPY … TO PROGRAM/'file'`, `pg_read_file`, `pg_terminate_backend`, `pg_reload_conf`, `pg_logical_emit_message`, `lo_export`, `dblink*`, `CALL`, `DO`, `SET`, …) — **regardless of the DB role's privileges**. Provide an explicit, fail-closed **`.env` escape hatch** to permit superuser/unsafe statements when an operator deliberately accepts the risk. Document the PRIMARY fix (non-superuser DB role) as a **human-only runbook**.

## Scope (confirmed with user)

- ✅ Statement allowlist + banned-function guard, shared lexer, wired at the choke point.
- ✅ Per-datasource `.env` escape hatch (`DS_<NAME>_ALLOW_UNSAFE_STATEMENTS`, default **false** = guard enforced).
- ✅ DB-role remediation documented as a runbook (NOT executed — `.claude/rules/no-migrations-rule.md`).
- ❌ Out of scope this round: token-scope boot warnings (M-3), external append-only audit sink, extension `.so` removal. Noted as follow-ups.

## Division of labor

| Report fix | Nature | This plan |
|---|---|---|
| #1 non-superuser role | **human DB action** | documented runbook only (Phase 05) |
| #2 statement guard | **code** | Phases 01–04 |
| escape hatch (user ask) | **code + config** | Phase 03 |

## Phases

| # | Phase | Status | File |
|---|-------|--------|------|
| 01 | Shared SQL lexer (`stripToCode`) — DRY tokenizer reused by single-statement + guard | ✅ Done | [phase-01](phase-01-shared-sql-lexer.md) |
| 02 | Statement guard (mode-aware allowlist + banned-function scan) at `QueryService.run()` | ✅ Done | [phase-02](phase-02-statement-guard.md) |
| 03 | `.env` escape hatch (`allowUnsafeStatements` per datasource) + boot visibility | ✅ Done | [phase-03](phase-03-config-escape-hatch.md) |
| 04 | Tests (lexer parity, guard, query-service integration; single-statement regression stays green) | ✅ Done | [phase-04](phase-04-tests.md) |
| 05 | DB-role runbook + docs (risk-report status, README, AI-context sync) | ✅ Done | [phase-05](phase-05-db-role-runbook-and-docs.md) |

**Dependency order:** 01 → 02 → 03 → 04. Phase 05 (docs) is independent and can run any time.

## Completion (2026-07-30)

- Shipped all 5 phases. `npm run typecheck` clean; `npm test` = 132 pass / 12 skipped (live-PG integration) / 0 fail.
- New: `src/query/sql-lexer.ts`, `src/query/statement-guard.ts`, `test/sql-lexer.test.ts`, `test/statement-guard.test.ts`, `docs/runbooks/agent-ro-pg-role.md`.
- Modified: `single-statement.ts` (consumes lexer, API unchanged), `query-service.ts` (guard wiring + audit), `config.schema.ts` + `load-config.ts` (flag), `assert-readonly-posture.ts` (boot WARN), `.env.example`, `README.md`, risk report status, design note (`../../docs/design-notes/pg-connection-pool-query-gateway.md`).
- AI-context sync: no `*_AI_CONTEXT.md`/`*_ARCHITECTURE.md` in this repo; authoritative README + design note updated instead.
- **Carry-over (human):** Fix #1 non-superuser DB role — runbook `docs/runbooks/agent-ro-pg-role.md`, still pending DBA action. This guard is defense-in-depth, not a substitute.

## Key invariants (do not break)

- The guard inspects **only `input.sql`** (caller SQL). The internal `BEGIN`/`SET LOCAL`/`COMMIT`/`DISCARD ALL` `conn.exec` calls are separate and untouched.
- `assertSingleStatement` stays **always-on** and **first** — the escape hatch relaxes only the new statement-type guard, never multi-statement smuggling.
- Never revert `postgres-driver.ts` to the two-arg `client.query` form; never move caller SQL ahead of the `SET LOCAL` preamble (report "Defenses that HELD").
- Guard is **default-enforced, fail-closed**. `allowUnsafeStatements` must be an explicit per-datasource opt-in, logged loudly at boot.
- The guard is **belt to the braces** — it ships *with*, never *instead of*, the non-superuser role (Phase 05). Denylists are inherently fragile.

## Success criteria (whole plan)

- A read-mode call running any C-1…C-4 / M-1 / M-2 payload is rejected with a 400 **before DB contact** when the datasource is guarded.
- Boot probe, introspection, and normal tenant `SELECT`/`WITH`/`EXPLAIN` reads still pass unchanged.
- With `DS_<NAME>_ALLOW_UNSAFE_STATEMENTS=true`, guarded statements run and boot logs a clear WARN.
- `npm run typecheck` + `npm test` green, including unchanged `single-statement.test.ts`.
