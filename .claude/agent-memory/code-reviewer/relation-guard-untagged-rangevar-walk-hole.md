---
name: relation-guard-untagged-rangevar-walk-hole
description: libpg-query omits the RangeVar type tag on statically-typed relation fields, so a key==='RangeVar' walk silently misses INSERT/UPDATE/DELETE/SELECT-INTO targets
metadata:
  type: project
---

relation-guard.ts's `walk()` collects a relation only when `key === 'RangeVar'`. libpg-query's parse-tree JSON tags a node with its type ONLY for generic `Node*` positions (fromClause, JOIN larg/rarg, USING, subselects, CTE bodies). For statically-typed `RangeVar*` fields it emits the RangeVar **bare, untagged** — e.g. `InsertStmt.relation`, `UpdateStmt.relation`, `DeleteStmt.relation`, `MergeStmt.relation`, `SelectStmt.intoClause.rel` all arrive as `{relname, schemaname?, inh, relpersistence, location}` with NO `RangeVar` wrapper key.

Consequence (found in review 2026-08-03, plan 20260803-1313-run-query-relation-guard-hardening): the walk skips every write/create TARGET. A write-mode token can `INSERT/UPDATE/DELETE`/`SELECT ... INTO` a denied table or a schema outside its caps and the relation guard extracts ZERO relations → ALLOWED. Reads are fully policed (fromClause is tagged); the hole is write-path only, but it defeats schema-per-tenant isolation + denied-tables on the P0 write path. Fail-open and silent.

**Why:** it's a non-obvious libpg-query serialization detail that no SELECT-based test exposes (all relation-guard tests are reads). **How to apply:** any parse-tree walk that discriminates relations by the `RangeVar` key must ALSO collect bare RangeVars (objects with a string `relname`) at typed-field positions, and must collect write targets UNCONDITIONALLY (not subject to CTE-scope skipping — `WITH t AS(...) INSERT INTO t` targets the real table). Related: [[pgcp-schema-caps-advisory]], [[statement-guard-quoted-identifier-bypass]].
