# Connection-identity function guard (run_query)

Date: 2026-08-07

## Problem

The `.env` secrets rule and the file-read privacy guard stop the agent from reading the
datasource's real user / database / host out of `pg-connection-pool/.env`. But a second
door was open: the MCP `run_query` itself. `SELECT current_user, current_database()`
references **no relation**, so `relation-guard`'s relation checks never fired, and
`banned-functions.ts` only covers file/RCE functions. A user testing the enhancement asked
for the db name and db user and the agent answered — by running exactly that query. The
identity keywords (`current_user`, `session_user`, `current_catalog`, `current_schema`)
weren't even *collected* by the parse-tree walk: Postgres parses them as `SQLValueFunction`
nodes, not `FuncCall`, and the walk only handled `FuncCall`.

## Structure

A new single-responsibility module `connection-info-functions.ts` owns the denylist:
identity/location function names (`current_user`, `current_database`, `inet_server_*`, …),
a `SQLValueFunction.op → canonical-name` map (so the keyword forms flow through the *same*
name denylist as the call forms), and the sensitive-GUC set for `current_setting`
(`session_authorization`, `role`).

`relation-guard.ts` is extended, not duplicated:
- `walk` gains a `SQLValueFunction` branch that maps the op to a name and pushes it into
  the existing `SqlRefs.functions` list — so one denylist check covers both node shapes.
- `collectFunction` additionally captures each `current_setting(...)` literal argument into
  a new `SqlRefs.settingArgs` (null when the argument is not a plain string constant).
- `assertRelationsAllowed` rejects (400) any function on the identity denylist, and any
  `current_setting` whose argument is a sensitive GUC or non-literal (fail-closed).

The guard is **always on** and needs no config field, so `query-service.ts` is unchanged.
It runs only for caller SQL: the boot posture probe and introspection use the internal
trusted route that bypasses `assertRelationsAllowed`, and `ALLOW_UNSAFE_STATEMENTS` opts out
the same as every other guard — so nothing internal self-blocks (the boot probe legitimately
reads `current_user`).

## Tradeoffs

- **Always-on vs configurable.** The sensitive-*relation* denylist is per-datasource
  configurable because table names are deployment-specific and can false-positive. Identity
  functions are universal — no read-gateway consumer needs to ask the DB who it connects as —
  so making it non-configurable removes a footgun and matches `banned-functions` (also fixed).
- **Curated identity list vs "block all system functions."** A blanket ban was rejected:
  `now()`, `current_date`, `current_timestamp` are legitimate and common in `WHERE` clauses.
  The list is scoped to functions that reveal user / database / host / schema.
- **`current_setting` arg-inspection.** Blocking `current_setting` wholesale would break the
  documented "use `current_setting('name')` instead of SHOW" guidance and the boot probe's
  own GUC read. Inspecting the literal argument keeps harmless GUC reads working while closing
  the `session_authorization` / `role` back door; a non-literal argument fails closed.
- **`version()` left readable.** It fingerprints the server version but is not connection
  identity or credentials, and blocking it buys little — kept out to hold the guard's scope
  tight and its rationale clean.

## Verification

`test/connection-info-functions.test.ts` (unit: matcher, op-map/denylist non-drift, setting
args) + new `relation-guard.test.ts` block (end-to-end: keyword forms, call forms,
in-projection/WHERE/qualified, `current_setting` GUCs, and date/time + `"user"` identifier
NOT blocked). Full suite: 207 tests green; `tsc --noEmit` clean.
