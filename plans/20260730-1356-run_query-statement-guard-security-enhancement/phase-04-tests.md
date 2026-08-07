# Phase 04 — Tests

## Context Links
- Plan: [plan.md](plan.md) · covers phases 01–03
- Test runner: `node --import tsx --test "test/**/*.test.ts"` (`npm test`)
- Existing suites: `test/single-statement.test.ts`, `test/query-service.test.ts`, `test/mcp-tools.test.ts`, `test/routes.e2e.test.ts`

## Overview
- **Priority:** P0 — the guard is a security control; it needs adversarial coverage.
- **Status:** ✅ Done.
- **Description:** Unit tests for the lexer and guard, plus integration through `QueryService` for enforced vs. relaxed modes. Existing `single-statement.test.ts` must pass **unmodified** as the refactor safety net.

## Requirements / Test Matrix

### `test/sql-lexer.test.ts` (new)
- Length invariant: `stripToCode(s).length === s.length` for varied inputs.
- Blanks: line/block comments, `'…'`, `E'\\''`, `"…"`, `$tag$…$tag$` — code chars preserved.
- Regression anchor: the `SELECT E'\''; COMMIT; …` case leaves the top-level `;` visible in stripped output.

### `test/statement-guard.test.ts` (new)
- **Allowed (read):** `SELECT 1`, `select 1`, `WITH t AS (SELECT 1) SELECT * FROM t`, `EXPLAIN SELECT 1`, `SHOW server_version`, `VALUES (1)`, `TABLE pg_class`, the boot-probe SQL, all three introspection SQLs.
- **Rejected (read):** every reproduction-table payload — C-1 `COPY … TO PROGRAM`, C-3 `COPY … TO '/tmp/f'`, C-4 `pg_read_file`, M-1 `pg_terminate_backend`, M-2 `pg_logical_emit_message`; plus `lo_export`, `dblink(`, `pg_reload_conf`, `pg_ls_dir`, `pg_stat_reset`, `CALL x()`, `DO $$…$$`, `SET x = y`, `ALTER SYSTEM SET …`, `CREATE TABLE …`, `TRUNCATE …`.
- **Bypass attempts (rejected):** `SELECT/**/pg_read_file('x')`, `SELECT  pg_catalog.pg_read_file('x')`, `Copy (SELECT 1) To Program 'id'`, dollar/newline-obfuscated variants.
- **False-positive guard (allowed):** `SELECT 'pg_read_file(' AS note`, `SELECT 'COPY' AS k`, a column/alias named `dblink` without `(`.
- **Write mode:** `assertStatementAllowed('INSERT INTO t VALUES (1)', {write:true})` passes; same with `{write:false}` rejects; `COPY … TO PROGRAM` rejected even with `{write:true}`.

### `test/query-service.test.ts` (extend, stubbed driver)
- Guarded datasource (`allowUnsafeStatements:false`): a banned payload throws `BadRequestError`, driver `connect` **never called** (assert no connection acquired).
- Relaxed datasource (`allowUnsafeStatements:true`): same payload passes the guard and reaches the stubbed driver.
- Existing wrap-order assertions (`BEGIN [READ ONLY] → SET LOCAL… → sql → COMMIT → DISCARD ALL`) still hold.
- Blocked-attempt auditing: assert an audit line is emitted for a guard rejection (drives the Phase-02 decision to add pre-connect audit if absent).

### Regression
- `test/single-statement.test.ts` passes with **zero** changes.
- `npm run typecheck` + full `npm test` green.

## Related Code Files
- **Create:** `test/sql-lexer.test.ts`, `test/statement-guard.test.ts`
- **Modify:** `test/query-service.test.ts`
- **Read for context:** `test/helpers.ts` (stub driver / fixtures)

## Implementation Steps
1. Lexer tests (length invariant + blanking + regression anchor).
2. Guard tests from the matrix above (drive payloads from the report's reproduction table).
3. Extend query-service tests for enforced/relaxed + no-connect-on-reject + audit-on-reject.
4. Run full suite; iterate until green.

## Todo List
- [x] `sql-lexer.test.ts`
- [x] `statement-guard.test.ts` (allow / reject / bypass / false-positive / write-mode)
- [x] Extend `query-service.test.ts` (enforced vs relaxed, no-connect, audit-on-reject)
- [x] `single-statement.test.ts` green unmodified
- [x] `npm run typecheck` + `npm test` green

## Success Criteria
- Every C-1…C-4 / M-1 / M-2 payload has a red→green rejection test.
- Relaxed-mode path proven to reach the driver.
- No existing test modified except the intentional `query-service.test.ts` extension.

## Risk Assessment
- **Test coupling to exact error strings** → assert on error *type* + a stable substring, not the whole message.

## Security Considerations
- Treat the reproduction table as the canonical regression corpus; add a payload here whenever a new primitive is discovered.

## Next Steps
- Phase 05 documents the durable role fix and updates the risk report status.
