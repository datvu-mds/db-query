# Runbook — non-superuser read-only DB role (`agent_ro_pg`)

**Status:** PRIMARY fix for [the 2026-07-29 RCE/write bypass](../risks/2026-07-29-mcp-run_query-write-and-rce-bypass.md). **Human DBA action — the agent must NOT run any SQL here** (`.claude/rules/no-migrations-rule.md`).

## Why this is the real fix

The gateway currently connects as a **superuser** (`mds_dev`). Under a superuser role, `BEGIN TRANSACTION READ ONLY` does **not** stop `COPY … TO PROGRAM/'file'`, `pg_read_file`/`pg_ls_dir`, `pg_reload_conf`, others' `pg_terminate_backend`, `pg_logical_emit_message`, `CREATE EXTENSION`, or untrusted-language `DO` — so a read-only token reached RCE + host file R/W + a persistent write.

The [statement guard](../../src/query/statement-guard.ts) and the [relation guard](../../src/query/relation-guard.ts) (both shipped) block these — and catalog/cross-schema/denied-table reads — at the app layer, but a **denylist is fragile** and is defense-in-depth only. The durable guarantee is a login role that simply **holds no privilege** to do any of it. Run the guards **and** the role — belt to the braces.

Where the relation guard's app-layer denylist stops short and this role takes over: a **view** in an allowed schema over a denied table still reads it (views run with owner privileges), and the shared `pg_read_all_data` role can read every relation the guard is not parsing for. Per-schema/per-table grants under a dedicated role are the only *hard* boundary. The deferred "explicit grants (drop `pg_read_all_data`)" variant below is that braces — the guard is the belt.

## Runbook (run as a human DBA, as superuser/owner)

```sql
-- 1. Create a non-superuser, read-only login role.
CREATE ROLE agent_ro_pg WITH LOGIN PASSWORD '<32+ char random>';

-- pg_read_all_data (PG14+): SELECT on all current AND FUTURE relations + schema USAGE.
-- Exactly right for schema-per-tenant, where new schemas appear at runtime.
GRANT pg_read_all_data TO agent_ro_pg;

-- Second lock: a plain BEGIN (the write path) is read-only too, so a mode misconfig
-- still cannot write. Advisory only — USERSET, so a caller can turn it off.
ALTER ROLE agent_ro_pg SET default_transaction_read_only = on;

-- PG14: PUBLIC still holds TEMP on the database and CREATE on schema public. Neither
-- can touch tenant data (session-local temp is cleared by DISCARD ALL), but revoke to
-- make the "no writes at all" claim literal. Check first with:
--   SELECT has_schema_privilege('public','public','CREATE');
REVOKE TEMP, CREATE ON DATABASE mds_dev FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

Then:

1. Set `DS_MDS_MAIN_USER=agent_ro_pg` and its new password in `.env`.
2. Leave `DS_MDS_MAIN_ALLOW_UNSAFE_STATEMENTS` **unset** (guard enforced) for this datasource.
3. Restart the gateway.
4. **Acceptance check:** the boot log prints `read-only posture OK` (not `WEAK` / `UNVERIFIED`) for the datasource.
5. Rotate the old weak `mds_dev` password regardless.

## Caveat the probe cannot cover

If `dblink` / `postgres_fdw` is installed, `EXECUTE` defaults to `PUBLIC` and `dblink('…','INSERT …')` writes over a *separate* connection — outside the read-only transaction and any grant the role holds. Revoke `EXECUTE` on those functions, or don't install them on a database this gateway reaches. (The statement guard also denies `dblink*` at the app layer.)
