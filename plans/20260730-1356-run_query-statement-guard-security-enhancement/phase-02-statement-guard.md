# Phase 02 — Statement guard (allowlist + banned-function scan)

## Context Links
- Plan: [plan.md](plan.md) · depends on [phase-01](phase-01-shared-sql-lexer.md)
- Choke point: `src/query/query-service.ts:72` (`run()`), right after `assertSingleStatement`
- Report exploits neutralized: C-1, C-2, C-3, C-4, M-1, M-2 (at the app layer)

## Overview
- **Priority:** P0 — the core defense-in-depth.
- **Status:** ✅ Done.
- **Description:** A mode-aware **allowlist** on the leading keyword plus a **banned-function scan** over the stripped code. Rejects side-effecting statements/functions before any DB contact. Enforced by default; skipped only when the datasource sets `allowUnsafeStatements` (Phase 03).

## Key Insights
- Pure allowlist on the leading keyword is stronger than a keyword denylist and simpler: anything not explicitly allowed is rejected. COPY/CALL/DO/SET/ALTER/CREATE/… all fall through to reject with no per-keyword list to maintain.
- Banned **functions** still need an explicit scan because they hide inside *allowed* statements (`SELECT pg_read_file(...)`, `WITH t AS (SELECT pg_terminate_backend(...))`, `EXPLAIN ANALYZE SELECT lo_export(...)`).
- Operating on `stripToCode(sql)` makes both checks immune to comment/string bypass and to string-literal false positives (`SELECT 'pg_read_file('` is blanked → no match).
- Single choke point ⇒ HTTP `/query`, MCP `run_query`, **and** introspection are all covered. Introspection SQL is `SELECT … information_schema.*` → passes.

## Requirements
- **Read mode** (`write===false`) allowed leading keywords: `SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE`.
- **Write mode** (`write===true`, i.e. write token + `readOnly:false`) allowed = read set **plus** `INSERT, UPDATE, DELETE, MERGE`.
- Banned function names rejected in **both** modes (dangerous regardless of write intent).
- Case-insensitive; tolerant of schema qualification (`pg_catalog.pg_read_file`).
- Throws a `BadRequestError` (→ HTTP 400 / MCP error) with an actionable message; no DB contact.
- No-op when the datasource's `allowUnsafeStatements` is true (wired in Phase 03).

## Architecture
New module `src/query/statement-guard.ts`:
```
export function assertStatementAllowed(sql: string, opts: { write: boolean }): void
```
Algorithm:
1. `const code = stripToCode(sql)`.
2. `leading = /[a-z_]+/i.exec(code)?.[0]?.toUpperCase()`. If absent or not in `allowSet(opts.write)` → throw `Statement type "<x>" is not permitted by this gateway.` (mention read vs write set).
3. Scan `code` (lowercased) against banned-function patterns; on match → throw `Function "<name>" is not permitted by this gateway.`

**Banned function patterns** (whole-identifier, followed by optional whitespace + `(`):
- File/dir/program: `pg_read_file`, `pg_read_binary_file`, `pg_stat_file`, `pg_ls_dir`, `pg_ls_\w+` (waldir/logdir/tmpdir/…)
- Large-object server files: `lo_export`, `lo_import`
- Cross-DB / RCE: `dblink\w*` (dblink, dblink_exec, dblink_connect[_u])
- Config / signal / log: `pg_reload_conf`, `pg_terminate_backend`, `pg_cancel_backend`, `pg_rotate_logfile`
- WAL / CDC / replication: `pg_logical_emit_message`, `pg_create_logical_replication_slot`, `pg_create_physical_replication_slot`, `pg_drop_replication_slot`, `pg_replication_slot_advance`, `pg_logical_slot_get_changes`, `pg_logical_slot_peek_changes`
- Observability tamper: `pg_stat_reset\w*`

Regex shape per name: `/\b<name>\s*\(/`. The `\b` matches after a `.` qualifier too. Keep the list as a small readonly array with a comment per group.

### Wiring
In `query-service.ts run()`, after the existing `assertSingleStatement` try/catch:
```ts
if (!dsCfg.allowUnsafeStatements) {
    try { assertStatementAllowed(input.sql, { write: input.write }); }
    catch (err) { throw new BadRequestError((err as Error).message); }
}
```
`dsCfg` is already fetched at `query-service.ts:80` (`this.pools.getConfig(...)`). Move the guard to just after that line (needs the datasource config for the flag), still before `driver.connect`.

## Related Code Files
- **Create:** `src/query/statement-guard.ts`
- **Modify:** `src/query/query-service.ts` (call the guard after resolving `dsCfg`, before connect)
- **Read for context:** `src/query/gateway-errors.ts`, `src/introspect/introspect-service.ts` (confirm its SELECTs pass)

## Implementation Steps
1. Author `statement-guard.ts` with `ALLOW_READ`, `ALLOW_WRITE = [...ALLOW_READ, INSERT, UPDATE, DELETE, MERGE]`, and the `BANNED_FUNCTIONS` regex list.
2. Implement `assertStatementAllowed` using `stripToCode`.
3. Wire into `query-service.ts` guarded by `dsCfg.allowUnsafeStatements` (flag added in Phase 03; until then treat as `false`).
4. Confirm introspection + boot-probe SQL pass (SELECT + non-banned funcs like `current_setting`, `has_table_privilege`, `to_regrole`).
5. `npm run typecheck`.

## Todo List
- [x] `statement-guard.ts` allowlist + banned list
- [x] `assertStatementAllowed` over `stripToCode`
- [x] Wire into `run()` after `dsCfg`, before connect, gated by `allowUnsafeStatements`
- [x] Verify boot probe + introspection SELECTs pass
- [x] typecheck green

## Success Criteria
- Rejected (read mode, guarded): `COPY (SELECT 1) TO PROGRAM 'id'`, `COPY (SELECT 'x') TO '/tmp/f'`, `SELECT pg_read_file('/etc/passwd')`, `SELECT pg_terminate_backend(1)`, `SELECT pg_logical_emit_message(false,'x','y')`, `SELECT lo_export(...)`, `SELECT dblink(...)`, `CALL x()`, `DO $$…$$`, `SET x=y`, `ALTER SYSTEM …`.
- Allowed: `SELECT …`, `WITH t AS (…) SELECT …`, `EXPLAIN SELECT …`, `SHOW …`, `VALUES (1)`, `TABLE foo`, the boot probe SQL, all three introspection queries.
- Bypass attempts fail: `SELECT/**/pg_read_file(…)`, `SELECT pg_catalog.pg_read_file(…)`, mixed case `Copy … To Program`.
- False-positive avoided: `SELECT 'pg_read_file(' AS note` is allowed.
- Write mode: `INSERT …`/`UPDATE …`/`DELETE …` allowed, but `COPY`/`pg_read_file` still rejected.

## Risk Assessment
- **Legit read blocked** (a real admin datasource needs `COPY`/file funcs) → that's what Phase 03's escape hatch is for; document it in the 400 message hint.
- **Banned list drift** vs new PG versions → keep list grouped + commented; this is defense-in-depth, the role fix (Phase 05) is the real guarantee.
- **False positive on a column literally named like a banned func** → requires `name(` shape; acceptably rare for an introspection gateway.

## Security Considerations
- Guard runs pre-DB, so rejected payloads never reach the engine and are still audit-logged as errors via the existing `auditError` path (the throw propagates through `run()`'s catch only after connect; for pre-connect rejects, confirm an audit line is emitted — add one if missing so blocked attempts are recorded).
- Ships **with**, never instead of, the non-superuser role (Phase 05).

## Next Steps
- Phase 03 adds the `allowUnsafeStatements` config flag the wiring reads.
