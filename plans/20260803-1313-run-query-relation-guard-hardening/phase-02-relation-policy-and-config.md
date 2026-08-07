# Phase 02 — Relation policy + `DS_<NAME>_DENIED_TABLES` config

## Context Links
- Plan: [plan.md](plan.md) · depends on [phase-01](phase-01-parser-and-relation-extraction.md)
- Design: [brainstorm](../reports/brainstorm-260803-run-query-relation-guard-hardening.md) §2 (policy) + §4 (config)
- Caps semantics to reuse: `src/auth/token-auth.ts` `authorize()` / private `allowed()`
- Config precedent: [20260730 phase-03](../20260730-1356-run_query-statement-guard-security-enhancement/phase-03-config-escape-hatch.md)

## Overview
- **Priority:** P0 — the actual security decision.
- **Status:** ⬜ Pending.
- **Description:** Add `assertRelationsAllowed(sql, policy)` to `src/query/relation-guard.ts`: metadata block, schema-caps boundary for qualified refs, implicit-`pg_%` block, denied-table check, plus the parser-side banned-function check. Add per-datasource `deniedTables` config and a `ForbiddenError` (403) type. **No wiring yet** (Phase 03).

## Key Insights
- `pg_catalog` is implicitly **first** on `search_path` and cannot be revoked in Postgres → an unqualified `pg_tables` resolves to the catalog even under a tenant `search_path`. All catalog relations are `pg_`-prefixed, so an unqualified `pg_%` name is always a catalog read attempt.
- System-schema test must match what `IntrospectService.visibleSchema()` already does (`startsWith('pg_') || === 'information_schema'`) — that covers `pg_catalog`, `pg_toast`, `pg_temp*`. Export one predicate and let introspect consume it (Phase 03) so the two policies cannot drift.
- Caps semantics stay exactly `authorize()`'s: `'*'` or explicit membership. Extract the existing private `allowed()` into an exported helper rather than reimplementing it.
- Denylist entries are compared **case-insensitively**. Postgres folds unquoted identifiers to lower case; a quoted `"User"` is technically a different table. Over-blocking is the correct failure direction for a denylist.
- Code default for `deniedTables` is **empty** — the gateway stays generic; the MDS list ships in `.env`/`.env.example` (Phase 05).

## Requirements
- `assertRelationsAllowed(sql, policy)` — async, throws, no I/O:
  - parse error → `BadRequestError` (fail-closed 400) with a message that names the parse failure.
  - relation qualified with a system schema → `BadRequestError` (metadata block; point at `list_schemas`/`list_tables`/`describe_table`).
  - relation qualified with a non-system schema outside caps → `ForbiddenError` (403).
  - relation unqualified and matching `pg_%` → `BadRequestError`.
  - effective schema (`ref.schema ?? policy.schema`) + relname in `deniedTables` → `BadRequestError`.
  - any called function matching the shared banned list → `BadRequestError` (parser path; closes the unicode-escape gap).
- Error messages must never echo row data and should name the offending relation only.
- Config: `DS_<NAME>_DENIED_TABLES` comma list; entries `table` (any schema) or `schema.table` (exact). Malformed entry (more than one dot) → **boot fails** with a clear message.
- Fallback datasource (`DATABASE_*`) gets `DATABASE_DENIED_TABLES`.

## Architecture

`src/query/gateway-errors.ts` — new type (`statusOf` picks it up automatically):

```ts
export class ForbiddenError extends Error {
    readonly status = 403;
    constructor(message: string) { super(message); this.name = 'ForbiddenError'; }
}
```

`src/auth/token-auth.ts` — export the caps predicate, keep `authorize()` on it (DRY, one semantics):

```ts
/** '*' wildcard or explicit membership — the ONE definition of a caps match. */
export function capabilityAllows(list: string[], value: string): boolean {
    return list.includes('*') || list.includes(value);
}
```
(replace the private `allowed()` with it; `authorize()` behaviour unchanged.)

`src/query/relation-guard.ts` — policy half:

```ts
export interface RelationPolicy {
    /** Effective (already authorized) schema — the target of unqualified refs. */
    schema: string;
    /** Token caps; ['*'] = any non-system schema. Caller passes caps.schemas. */
    allowedSchemas: string[];
    /** Per-datasource denied tables: `table` | `schema.table`. */
    deniedTables: string[];
}

const METADATA_HINT = 'Use list_schemas / list_tables / describe_table for structure — run_query does not expose catalog or information_schema relations.';

/** pg_catalog, pg_toast, pg_temp_*, information_schema — same rule as
 *  IntrospectService.visibleSchema, exported so the two cannot drift. */
export function isSystemSchema(name: string): boolean {
    const n = name.toLowerCase();
    return n === 'information_schema' || n.startsWith('pg_');
}

export async function assertRelationsAllowed(sql: string, policy: RelationPolicy): Promise<void> {
    let refs: SqlRefs;
    try {
        refs = await extractSqlRefs(sql);
    } catch (err) {
        // Fail-closed: SQL this gateway cannot understand is SQL it cannot police.
        throw new BadRequestError(`SQL could not be parsed, so it cannot be checked: ${(err as Error).message}`);
    }

    for (const name of refs.functions) {
        if (bannedFunctionName(name)) throw new BadRequestError(`Function "${name}" is not permitted by this gateway.`);
    }

    for (const ref of refs.relations) {
        if (ref.schema) {
            if (isSystemSchema(ref.schema))
                throw new BadRequestError(`Relation "${ref.schema}.${ref.relation}" is not readable through run_query. ${METADATA_HINT}`);
            if (!capabilityAllows(policy.allowedSchemas, ref.schema))
                throw new ForbiddenError(`schema "${ref.schema}" not permitted`);   // same wording as authorize()
        } else if (/^pg_/i.test(ref.relation)) {
            // Unqualified pg_% resolves to pg_catalog (implicitly first on search_path).
            throw new BadRequestError(`Relation "${ref.relation}" is not readable through run_query. ${METADATA_HINT}`);
        }

        const effective = ref.schema ?? policy.schema;
        if (isDenied(effective, ref.relation, policy.deniedTables))
            throw new BadRequestError(`Relation "${effective}.${ref.relation}" is on this datasource's denied-table list.`);
    }
}

/** `table` matches in ANY schema; `schema.table` must match both. Case-insensitive:
 *  PG folds unquoted identifiers to lower case and a denylist should over-block. */
function isDenied(schema: string, relation: string, denied: string[]): boolean {
    const s = schema.toLowerCase();
    const r = relation.toLowerCase();
    return denied.some((entry) => {
        const e = entry.toLowerCase();
        const dot = e.indexOf('.');
        return dot === -1 ? e === r : e.slice(0, dot) === s && e.slice(dot + 1) === r;
    });
}
```

`src/config/config.schema.ts` — inside `datasourceSchema`:

```ts
// Per-datasource sensitive-relation denylist enforced by the relation guard
// (relation-guard.ts). Entries are `table` (any schema) or `schema.table`.
// Code default is EMPTY on purpose: the gateway stays generic, deployments
// declare their own list in .env. Skipped by allowUnsafeStatements, like the
// statement guard.
deniedTables: z
    .array(z.string().min(1).regex(/^[^.]+(\.[^.]+)?$/, 'expected "table" or "schema.table"'))
    .default([]),
```

`src/config/load-config.ts`:
```ts
deniedTables: list(env(`${p}DENIED_TABLES`)),          // buildDatasource
deniedTables: list(env('DATABASE_DENIED_TABLES')),     // fallbackDatasource
```
(`list()` already trims + drops empties; `[]` and the zod default are equivalent.)

`test/helpers.ts` — `makeConfig()` datasource literal gains `deniedTables: []` (config-shape owner = this phase; every other test edit belongs to Phase 04).

## Related Code Files
- **Modify:** `src/query/relation-guard.ts` (policy half), `src/query/gateway-errors.ts`, `src/auth/token-auth.ts`, `src/config/config.schema.ts`, `src/config/load-config.ts`, `test/helpers.ts`
- **Create:** none
- **Read for context:** `src/introspect/introspect-service.ts` (`visibleSchema`), `src/routes/route-helpers.ts`

## Implementation Steps
1. Add `ForbiddenError` to `gateway-errors.ts`.
2. Export `capabilityAllows` from `token-auth.ts`; rewire `authorize()` to it (no behaviour change).
3. Add `isSystemSchema`, `RelationPolicy`, `assertRelationsAllowed`, `isDenied` to `relation-guard.ts`.
4. Add `deniedTables` to `datasourceSchema` + both loader builders.
5. Add `deniedTables: []` to `test/helpers.ts` `makeConfig()`.
6. `npm run typecheck`; `npm test` (nothing wired yet → all existing tests still green).

## Todo List
- [ ] `ForbiddenError` (403) added
- [ ] `capabilityAllows` exported and reused by `authorize()`
- [ ] `isSystemSchema` + `assertRelationsAllowed` + `isDenied` implemented
- [ ] `deniedTables` in zod schema (with `schema.table` format validation) + loader + fallback
- [ ] `makeConfig()` updated
- [ ] typecheck + full suite green (behaviour unchanged, guard not yet wired)

## Success Criteria
- Policy unit-callable: `assertRelationsAllowed('SELECT * FROM pg_tables', {schema:'public',allowedSchemas:['*'],deniedTables:[]})` throws `BadRequestError`.
- `'SELECT * FROM "tenant_b".t'` with `allowedSchemas:['public']` throws `ForbiddenError` (status 403).
- Same SQL with `allowedSchemas:['*']` passes.
- `'SELECT * FROM "user"'` with `deniedTables:['user']` throws; with `deniedTables:['public.user']` and `schema:'public'` throws; with `deniedTables:['other.user']` passes.
- `'SELECT'` (invalid) throws `BadRequestError` mentioning parse failure.
- Boot rejects `DS_MAIN_DENIED_TABLES=a.b.c` with the zod message.
- Existing suite unchanged and green.

## Risk Assessment
| Risk | L×I | Mitigation |
|---|---|---|
| Over-blocking a legitimately-named tenant table (e.g. a tenant's own `role`) | **High** × Med | Bare entries match any schema by design; if it bites, switch that entry to `public.role` in `.env` — documented in Phase 05 |
| `'*'` caps token loses cross-schema reads it relied on | Med × Med | `'*'` still allows any non-system schema; only explicit-list tokens are newly confined (that is the point) |
| Case-insensitive match blocks a distinct quoted `"User"` table | Low × Low | Accepted and documented — denylists must over-block |
| Denylist scan cost per query | Low × Low | ≤ ~20 entries × ≤ a handful of relations; pure string compares, no allocation of note |
| Policy drift vs `IntrospectService.visibleSchema` | Med × Med | Single exported `isSystemSchema`; introspect refactored onto it in Phase 03 |

## Security Considerations
- **Fail-closed** in every branch: parse error rejects, unknown shapes never "pass by default", `allowedSchemas` is required by the type.
- 403 vs 400 split matters for the audit stream: 403 = caps violation (tenant-boundary probe), 400 = policy/metadata/denylist. Both are audited in Phase 03.
- Error text names only the relation the caller already typed — no enumeration of what else exists.
- This is still app-layer: the DB role keeps `pg_read_all_data`, and a **view** in an allowed schema over a denied table still leaks it (accepted residual risk, documented in Phase 05).

## Next Steps
- Phase 03 wires this into `QueryService.run()`, threads `caps.schemas`, and opens the internal trusted path for introspection + the boot probe.
