# Statement Guard: Quoted-Identifier Bypass & DRY Design Flaw

**Date**: 2026-07-30 15:30  
**Severity**: High  
**Component**: pg-connection-pool query-service  
**Status**: Resolved  

## What Happened

Shipped statement-guard (5 phases) to block RCE/write bypass on read-only MCP token. The guard enforces leading-keyword allowlist (read: SELECT/WITH/EXPLAIN/SHOW; write adds INSERT/UPDATE/DELETE) and scans for banned functions (pg_read_file, pg_ls_*, lo_export, dblink*, etc.). Adversarial code review caught a REAL working bypass: **quoted identifiers were being blanked in the shared lexer view, so `SELECT "pg_read_file"(...)` slipped past the function filter.**

## The Brutal Truth

We shipped a security layer with opposite design requirements in a shared data structure. The lexer produced a "code-only" normalized view by blanking comments, strings, and dollar-quoted bodies. But the single-statement scanner needed quoted identifiers blanked (to prevent `;` smuggling), while the function scanner needed them revealed (to detect function calls). **DRY applied without checking compatibility.** Tests passed because C-BYPASS-1 wasn't in the corpus.

## Technical Details

- **Attack vector**: `SELECT "pg_read_file"(...)` — Postgres resolves quoted-lowercase identifiers to functions at runtime
- **Original flaw**: stripToCode blanked both delimiters AND content, so function regex saw empty space where `pg_read_file` should be
- **Fix**: Added `revealQuotedIdents` mode that blanks only `"` delimiters, preserves inner names
  - Function scan runs over this view; keyword + single-statement scans stay fully blanked
  - Bypass reproduced at guard layer, then confirmed closed
  - No false positives; 136 tests pass, 0 fail
- **Residual risk**: Unicode-escape identifiers (U&"\0070...") still evade text lexer — documented as unfixable by lexer alone. **Closed 2026-08-03** by the relation guard (`src/query/relation-guard.ts`), which runs the SAME banned-function list against `libpg-query`'s DECODED parse-tree names — `U&"\0070g_read_file"` arrives as `pg_read_file` and is rejected. The text scan stays as belt-and-braces; both share one list (`banned-functions.ts`) so they cannot drift. See plan `plans/20260803-1313-run-query-relation-guard-hardening/`.

## Root Cause Analysis

Two consumers of a normalized view had **opposite, undiscovered requirements**. Single-statement needs blanked quotes (prevent `;` evasion). Function detector needs visible quotes (catch function calls). Same view can't satisfy both. No requirement validation before DRY abstraction.

## Lessons Learned

Before normalizing a shared data structure, verify that all consumers have *compatible* requirements. **Opposite requirements are a smell** — either split the view, or the abstraction is doing too much. Don't assume DRY is always cleaner.

## Next Steps

- Non-superuser DB role (Fix #1) still pending — guard is belt-to-braces, not a substitute
- Escape hatch documented: `DS_<NAME>_ALLOW_UNSAFE_STATEMENTS` (default false, fail-closed)
- M-AUDIT-1: assertSingleStatement rejections now routed to auditError stream

**Branch**: feat/run_query-statement-guard, commit 4009176 (not pushed)  
**Verification**: typecheck clean, 136 pass / 12 skipped / 0 fail
