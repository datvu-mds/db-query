---
name: pgcp-schema-caps-advisory
description: pg-connection-pool token `schemas` capability is not an access boundary — it only checks the declared target schema, not the SQL body
metadata:
  type: project
---

In `pg-connection-pool` (query gateway), a token's `SCHEMAS` allow-list is enforced in
`TokenAuth.authorize` against the *declared* request `schema` only. The caller SQL is
arbitrary and runs as one shared DB role with access to all schemas; `SET LOCAL search_path`
only affects UNqualified name resolution, so `SELECT/INSERT ... FROM "other_tenant".t`
bypasses the schema scoping. `run_query` can also enumerate all schemas via
`information_schema` (only the `listSchemas` helper filters by caps).

**Why:** flagged during the 2026-07-14 production-readiness review. The separate P0 invariant
(no `search_path` leak between pooled borrowers via `SET LOCAL` in a txn) IS correctly
implemented and re-applied per query on read+write paths — do not confuse the two.

**How to apply:** when reviewing changes to auth/query-service, do NOT treat `schemas` caps as
a tenant boundary. Real confinement would need role-per-token with revoked cross-schema USAGE
(incompatible with the shared pool) or SQL table-ref validation. Until then it's a trusted-caller
utility; the README should say schema caps gate the declared target only.
