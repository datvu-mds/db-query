# Relation Guard: Parse-Tree AST Walker Fail-Open Bug & Parser-Native Boundary

**Date**: 2026-08-03 13:15  
**Severity**: Critical (shipped with defect, caught in code review before merge)  
**Component**: pg-connection-pool query-service  
**Status**: Resolved  

## What Happened

Shipped relation guard (Phase 5, `pgpool-relation-guard-plan.md`) to close C-4 metadata exfil + enforce M-3 schema-cap boundary at the QueryService.run() choke point. Guard parses every statement with libpg-query@18.1.4 (real Postgres WASM parser), rejects per-relation: catalog schemas (pg_catalog, information_schema, pg_toast, pg_temp*) → 400, cross-schema reads → 403, denied tables per datasource → 400. Fail-closed; unreachable from HTTP. Adversarial code review caught a **fail-open defect**: the AST walker extracted zero relations from write targets (INSERT/UPDATE/DELETE/MERGE and SELECT…INTO), leaving a write-mode token able to bypass all policy entirely.

## The Brutal Truth

libpg-query's parse tree emits relation references in two forms: wrapped (`{ "RangeVar": { relname, schemaname } }`) at generic `Node*` positions, and **bare** (`{ relname, schemaname }` directly, no wrapper) on statically-typed object fields. The initial walker only collected `key === 'RangeVar'` matches, so it saw zero relations from INSERT/UPDATE targets (emitted as bare `.relation`), CREATE TABLE (`.relation`), and SELECT…INTO (`.intoClause.rel`). Tests stayed green because the test corpus had no write-target assertions — a clear test-data gap. **Durable lesson**: real parser ASTs use static typing; type keys are NOT the only place nodes appear.

## Technical Details

- **Attack vector**: `INSERT INTO sensitive_table VALUES (...)`  where sensitive_table is a denied/cross-tenant table — would execute with zero relation-guard checks
- **Original flaw**: Bare RangeVars on typed object fields (`.relation`, `.intoClause.rel`, `.createStmt.relation`) were never collected; only generic `key === 'RangeVar'` matched wrapped forms
- **Root of defect**: Assumption that libpg-query wraps all node types in a `{ NodeType: ... }` key. **Wrong.** Statically-typed fields inline the full node object naked.
- **Fix**: Walk now collects relation targets UNCONDITIONALLY — `typeof obj.relname === 'string'` detect bare RangeVar anywhere in tree. No CTE-scope skipping (you cannot write into a CTE; a table named `cte_name` is the real table, policy checks it). Tests added: write-path extraction (INSERT/UPDATE/DELETE/MERGE/CREATE TABLE/SELECT…INTO); policy regression (denied table → 400; cross-schema → 403; connectCount === 0).
- **Verification**: 196 tests / 181 pass / 15 skipped (live-PG integration) / 0 fail; typecheck clean; relation-guard now correctly audits all write/create targets before any DB contact

## Root Cause Analysis

Initial walker design assumed parse-tree structure without checking the real emitter. Statically-typed languages (TypeScript, protobuf, Go structs) optimize by inlining — type keys only appear at polymorphic positions. Test coverage relied on SELECT (easy to test), omitting write-path (low incident rate, low visibility until breach). No architectural review of parser semantics before implementation.

## Lessons Learned

1. **Real-world AST walkers cannot rely on type keys alone.** Static typing embeds nodes directly; walk the object structure AND check field types. Use `typeof field.relname === 'string'` alongside key matching.
2. **Write paths must be in the test corpus from day one.** A security boundary is only as good as its test coverage; if the majority of the codebase never hits write statements, those paths will silently fail.
3. **Adversarial code review catches what unit tests cannot.** The developer tested SELECT; the reviewer asked "what about DELETE?" — and found zero extraction.

## Next Steps

- **User action (no-migrations rule)**: Add `DS_MAIN_DENIED_TABLES` to live `.env` (until then, no tables are actively denied; guard is armed but table list empty)
- **Cleanup**: Remove PoC artifacts (`public.env_dump`, `public.pg_rce_out`), rotate PoC secrets (live SaaS only, dev .env unaffected)
- **Durable fix (future)**: Explicit per-schema grants to drop `pg_read_all_data` (requires DB role change; this guard is belt-to-braces)

**Branch**: feat/run-query-relation-guard, commit c5c8d22  
**Plan**: plans/20260803-1313-run-query-relation-guard-hardening/  
**Verification**: typecheck clean, 196 total / 181 pass / 15 skipped / 0 fail
