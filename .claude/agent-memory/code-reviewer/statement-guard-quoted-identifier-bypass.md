---
name: statement-guard-quoted-identifier-bypass
description: statement-guard banned-function scan runs over stripToCode, which BLANKS double-quoted identifiers, so quoted function names bypass the denylist
metadata:
  type: project
---

The `statement-guard.ts` banned-function denylist scans the `stripToCode()` view. `stripToCode` (sql-lexer.ts) blanks double-quoted identifiers to spaces (correct for the `;` multi-statement check, WRONG for a function-name scan).

Result: a quoted function name vanishes from the scanned view, but Postgres still resolves the lowercase quoted identifier to the same function. So `SELECT "pg_read_file"('/etc/passwd',0,200)`, `pg_catalog."pg_read_file"(…)`, `SELECT * FROM "pg_ls_dir"('/')`, `"pg_terminate_backend"(1)`, `U&"pg_read_file"(…)` all pass the guard in READ mode. Confirmed empirically 2026-07-30 (guardPASSED=true for all). Statement-TYPE allowlist is NOT affected (COPY/DO/CALL/SET can't be quoted as a statement start) — only the banned-FUNCTION half.

**Why:** the shared-lexer "both consumers read the same normalized view" design is the trap — the single-statement scanner WANTS quoted identifiers blanked; the banned-function scanner must NOT blank them.

**How to apply:** when reviewing any change to this guard, verify the banned-function scan sees quoted-identifier content (case-sensitive; unicode-escaped `U&"…"` too). Reinforces the file's own note: the denylist is fragile — the non-superuser DB role ([[pgpool-mcp-superuser-rce-risk]], still pending) is the durable fix. Related: [[pgcp-schema-caps-advisory]].
