# Phase 03 — Wiring: `QueryService.run()`, internal trusted path, boot log, `SHOW` removal

## Context Links
- Plan: [plan.md](plan.md) · depends on [phase-02](phase-02-relation-policy-and-config.md)
- Design: [brainstorm](../reports/brainstorm-260803-run-query-relation-guard-hardening.md) §3 (SHOW) + §5 (introspection internal path)
- Choke point: `src/query/query-service.ts` `run()` — after `assertStatementAllowed`, before `driver.connect`
- Transports: `src/routes/query.route.ts`, `src/mcp/tools.ts`
- Internal callers: `src/introspect/introspect-service.ts`, `src/boot/assert-readonly-posture.ts`

## Overview
- **Priority:** P0 — nothing is enforced until this lands; it is also the phase that can break boot and introspection.
- **Status:** ⬜ Pending.
- **Description:** Call `assertRelationsAllowed` at the choke point (audited, pre-DB), thread the token's `caps.schemas` from both transports, open an **internal-only** trusted path for the two fixed catalog callers, remove `SHOW` from the read allowlist, and log the guard posture per datasource at boot.

## Key Insights
- **Two internal callers, not one.** The brainstorm names `IntrospectService`; live code shows `assert-readonly-posture.ts` also runs `PROBE_SQL` through `QueryService.run()`, and that SQL reads `pg_roles`, `pg_class`, `pg_namespace` — all unqualified `pg_%`. Without the bypass, **every boot would report `read-only posture UNVERIFIED`**, i.e. the security check silently dies. Non-negotiable.
- **The trust flag must be a second positional argument, not a `RunInput` field.** `RunInput` is built from request input; the day someone writes `run({ ...body, tokenId })` a field-based flag becomes a caller-settable bypass. A second parameter cannot be carried by any JSON body or MCP args object — unreachable by construction, not by convention.
- **Transports DO need a change** (the task asked to verify): `run()` currently receives only `tokenId`, so the guard has no caps. Each transport adds `allowedSchemas: caps.schemas`. Default when absent is `[input.schema]` — fail-closed, so a forgotten call site over-blocks rather than under-blocks.
- `SHOW` leaks server settings (`SHOW all` → `data_directory`, `config_file`, connection strings in some setups) and has no relations for the guard to police, so it must leave the allowlist rather than be special-cased.
- Guard placement is **inside** the `!dsCfg.allowUnsafeStatements` regime: the escape hatch skips the relation guard too (agreed), and `assertSingleStatement` stays first and always-on.

## Requirements
- Relation guard runs after `assertStatementAllowed`, before `driver.connect`; rejections audited via the existing `auditError` path and rethrown unchanged (400 or 403 → `statusOf` maps both).
- `allowUnsafeStatements=true` OR internal trust ⇒ relation guard skipped. Nothing else skips it.
- HTTP `POST /query` and MCP `run_query` pass `allowedSchemas: caps.schemas`.
- `IntrospectService`'s three fixed SELECTs and the boot probe pass the internal trust object.
- Boot logs, per datasource: relation guard on/off, denied-table count, catalog block on/off.
- `SHOW` removed from `ALLOW_READ`; `EXPLAIN` stays.
- MCP `run_query` tool description states the restrictions so an agent does not burn turns discovering them.

## Architecture

`src/query/query-service.ts`:

```ts
export interface RunInput {
    // …unchanged…
    /** Token schema capabilities (caps.schemas); ['*'] = any non-system schema.
     *  Omitted ⇒ only `schema` itself is allowed (fail-closed). */
    allowedSchemas?: string[];
}

/**
 * Internal trust marker for the gateway's OWN fixed catalog SQL (introspection,
 * boot posture probe). Deliberately a SECOND POSITIONAL ARGUMENT, never a RunInput
 * field: an HTTP body or MCP args object can be spread into RunInput, but it can
 * never become argument #2. Only in-process callers holding a QueryService can set it.
 */
export interface InternalTrust {
    internalCatalogQuery: true;
    reason: 'introspection' | 'boot-probe';
}

async run(input: RunInput, internal?: InternalTrust): Promise<RunResult> {
    // …assertSingleStatement… then dsCfg… then assertStatementAllowed…

    // Relation guard: which relations does this SQL actually touch? Parses with the
    // real PG parser and enforces catalog block + schema caps + denied tables before
    // any DB contact. Skipped for the gateway's own catalog SQL and for a datasource
    // the operator has explicitly opted out.
    if (!dsCfg.allowUnsafeStatements && !internal?.internalCatalogQuery) {
        try {
            await assertRelationsAllowed(input.sql, {
                schema: input.schema,
                allowedSchemas: input.allowedSchemas ?? [input.schema],
                deniedTables: dsCfg.deniedTables,
            });
        } catch (err) {
            this.auditError(input, started, (err as Error).message);
            throw err;                       // BadRequestError 400 | ForbiddenError 403
        }
    }
    // …clamps, connect, txn wrap unchanged…
}
```

`src/routes/query.route.ts` and `src/mcp/tools.ts` (`run_query`) — one added property each:
```ts
allowedSchemas: caps.schemas,
```

`src/introspect/introspect-service.ts`:
```ts
/** The three SELECTs below are fixed, parameterized information_schema reads —
 *  the sanctioned, caps-filtered metadata path. They must bypass the relation
 *  guard's catalog block or discovery breaks entirely. */
const INTERNAL: InternalTrust = { internalCatalogQuery: true, reason: 'introspection' };
// …all three call sites: this.queryService.run({ … }, INTERNAL)
```
Also refactor `visibleSchema` to use the exported `isSystemSchema` (drops the duplicated `pg_`/`information_schema` test).

`src/boot/assert-readonly-posture.ts`:
```ts
const INTERNAL: InternalTrust = { internalCatalogQuery: true, reason: 'boot-probe' };
// probe(): services.queryService.run({ … }, INTERNAL)  ← PROBE_SQL reads pg_roles/pg_class
```
Plus, in the per-datasource loop next to the existing `allowUnsafeStatements` WARN:
```ts
const cfg = services.pools.getConfig(datasource);
if (cfg.allowUnsafeStatements) {
    log.warn({ datasource }, '… relation guard also DISABLED (catalog/metadata reads and denied tables are permitted)');
} else {
    log.info(
        { datasource, deniedTables: cfg.deniedTables.length, catalogBlock: true },
        `relation guard ENFORCED for datasource "${datasource}" — catalog/information_schema blocked in run_query, ` +
            `${cfg.deniedTables.length} denied table pattern(s)`,
    );
}
```
Parser warm-up (first line of `assertReadOnlyPosture`, both entrypoints already call it):
```ts
// Load the WASM parser once at boot so the first user query doesn't pay for it and
// a broken install is loud here rather than as a 400 on someone's query.
try { await extractSqlRefs('SELECT 1'); }
catch (err) { log.error({ err: (err as Error).message }, 'SQL parser failed to initialise — every guarded query will be rejected'); }
```

`src/query/statement-guard.ts`: drop `SHOW` from `ALLOW_READ`; update the header comment and the README-facing wording. New list: `SELECT, WITH, EXPLAIN, VALUES, TABLE`.

`src/mcp/tools.ts` `run_query` description, append:
> Catalog/`information_schema` relations and some sensitive tables are blocked — use `list_schemas`/`list_tables`/`describe_table` for structure.

## Related Code Files
- **Modify:** `src/query/query-service.ts`, `src/query/statement-guard.ts`, `src/routes/query.route.ts`, `src/mcp/tools.ts`, `src/introspect/introspect-service.ts`, `src/boot/assert-readonly-posture.ts`
- **Create:** none
- **Read for context:** `src/query/gateway-errors.ts` (`statusOf`), `src/services.ts`, `src/routes/route-helpers.ts`

## Implementation Steps
1. Add `allowedSchemas` + `InternalTrust` to `query-service.ts`; insert the guard block at the choke point with the `auditError` wrapper.
2. Thread `allowedSchemas: caps.schemas` in `query.route.ts` and `tools.ts`.
3. Introspection: add `INTERNAL` and pass it at all three `run()` call sites; refactor `visibleSchema` onto `isSystemSchema`.
4. Boot probe: pass `INTERNAL` (verify by running the suite — `assert-readonly-posture.test.ts` must not regress).
5. Add the boot posture log lines + parser warm-up in `assert-readonly-posture.ts`.
6. Remove `SHOW` from `ALLOW_READ`; update the module header comment.
7. Update the MCP `run_query` description.
8. `npm run typecheck`; `npm test` — expect exactly two intended failures to fix in Phase 04: `statement-guard.test.ts` (`SHOW server_version` now rejected) and any fixture SQL that is not parseable.
9. Grep-audit for bypass reachability: `grep -rn "internalCatalogQuery" src/` must show only `query-service.ts`, `introspect-service.ts`, `assert-readonly-posture.ts`.

## Todo List
- [ ] `allowedSchemas` + `InternalTrust` on `run()`; guard block wired, audited, pre-connect
- [ ] Both transports pass `caps.schemas`
- [ ] Introspection 3 call sites on the internal path; `visibleSchema` → `isSystemSchema`
- [ ] Boot probe on the internal path (posture stays OK/WEAK, never UNVERIFIED)
- [ ] Boot log: guard state + denied-table count per datasource; parser warm-up
- [ ] `SHOW` removed from `ALLOW_READ`
- [ ] MCP tool description updated
- [ ] Grep-audit shows no transport can reach the internal flag

## Success Criteria
- `POST /query {sql:'SELECT * FROM information_schema.tables'}` → 400 + one audit entry with the error.
- `run_query 'SELECT * FROM pg_tables'` → error result, no DB contact (stub driver records zero connects).
- Restricted-caps token (`schemas:['public']`) running `SELECT * FROM "tenant_b".t` → 403.
- `'*'` token running `SELECT * FROM "tenant_b".t` → 200 (unchanged).
- `SHOW all` → 400.
- `list_schemas` / `list_tables` / `describe_table` → unchanged results.
- Boot log shows one relation-guard line per datasource; posture line still OK/WEAK.
- `DS_MAIN_ALLOW_UNSAFE_STATEMENTS=true` → relation guard skipped, WARN mentions it.

## Risk Assessment
| Risk | L×I | Mitigation |
|---|---|---|
| Boot probe blocked → posture reports UNVERIFIED forever (security check dies quietly) | **High** × **High** | Step 4 + explicit success criterion + Phase 04 test asserting the probe still yields a verdict |
| Introspection blocked → MCP discovery breaks | **High** × High | Internal path + existing `introspect-service.test.ts` green |
| Internal flag reachable from a request body | Low × **Critical** | Second positional arg (cannot come from JSON); zod strips unknown body keys; grep-audit; Phase 04 proof tests over HTTP and MCP |
| Transport forgets `allowedSchemas` → legit cross-schema reads 403 | Med × Med | Fail-closed default is deliberate; both call sites listed here and covered by e2e tests |
| Removing `SHOW` breaks a caller relying on `SHOW server_version` | Med × Low | Documented in Phase 05; `SELECT version()` / `current_setting()` remain |
| Async guard adds latency to every query | Med × Low | Parse of one statement is sub-millisecond after the boot warm-up |

## Security Considerations
- Guard sits **before** `driver.connect` — rejected payloads never reach the engine, and both 400s and 403s land in the audit stream (403s on qualified cross-schema refs are the tenant-probe signal worth alerting on).
- The internal path is the *only* trusted route and it carries **fixed, parameterized** SQL defined in-module; no caller-supplied string ever travels with it. Keep it that way — never widen `InternalTrust` to accept caller SQL.
- Escape hatch now disables two layers (statement + relation guard); the boot WARN must say so explicitly.
- Read-only txn, `SET LOCAL search_path`, `DISCARD ALL`, extended-protocol pinning: all untouched.

## Next Steps
- Phase 04 proves each rule and each bypass attempt; Phase 05 documents the new posture and the `.env` list.
