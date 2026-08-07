# Phase 04 — Tests

## Context Links
- Plan: [plan.md](plan.md) · depends on [phase-03](phase-03-query-service-wiring-and-internal-path.md)
- Conventions: `node:test` + `node:assert/strict`, run by `npm test` (`node --import tsx --test "test/**/*.test.ts"`)
- Harnesses to reuse: `test/helpers.ts` (`makeConfig`, `StubDriver`, `CapturingAudit`), `test/mcp-tools.test.ts` (`FakeMcp`), `test/routes.e2e.test.ts` (`app.inject`)
- Prior-art phase: [20260730 phase-04](../20260730-1356-run_query-statement-guard-security-enhancement/phase-04-tests.md)

## Overview
- **Priority:** P0 — a security guard with untested branches is a guess.
- **Status:** ⬜ Pending.
- **Description:** Unit tests for extraction + policy, service-level tests for wiring/audit/no-DB-contact, transport tests incl. **proof that an HTTP or MCP caller cannot set the internal trust flag**, plus regression fixes for `SHOW` and any unparseable fixture SQL.

## Key Insights
- The stub driver makes "no DB contact" directly assertable: `stub.connectCount === 0` after a rejected call. Use it — "returns 400" alone would pass even if the guard ran too late.
- CTE shadowing is the subtlest correctness case and the easiest bypass to regress. Test **both** directions: a CTE that legitimately shadows a denied name, and a later CTE name that must **not** mask an earlier real reference.
- The unicode-escape case (`U&"\0070g_read_file"`, `U&"\0075ser"`) is the reason the parser exists; it must be asserted, not assumed.
- Existing tests define the "unchanged behavior" baseline — treat any unexpected red as a real regression, not a fixture to loosen (see `scope-fix-tests-not-source`).

## Requirements
Test matrix (each row = at least one assertion):

**Extraction — `test/relation-guard.test.ts` (new, unit)**
| Case | Expect |
|---|---|
| `SELECT * FROM a`, `FROM s.b`, 3-way JOIN | all relations, schemas preserved |
| subquery in `FROM`, scalar subquery in `SELECT`, `IN (SELECT …)` | inner relations collected |
| `WITH t AS (SELECT 1) SELECT * FROM t` | no relations |
| `WITH "user" AS (SELECT 1) SELECT * FROM "user"` | no relations (legit shadow) |
| `WITH a AS (SELECT * FROM "user"), "user" AS (SELECT 1) SELECT * FROM a` | `user` **is** collected |
| `WITH RECURSIVE r AS (SELECT 1 UNION ALL SELECT * FROM r) SELECT * FROM r` | no relations |
| `EXPLAIN SELECT * FROM t` / `EXPLAIN (FORMAT JSON) …` | inner relation collected |
| `VALUES (1)`, `SELECT 1` | empty, no throw |
| `SELECT "MixedCase".t` / quoted `"user"` | identifier case preserved as written |
| `SELECT U&"\0070g_read_file"('/x')` | function `pg_read_file` |
| `SELECT * FROM U&"\0075ser"` | relation `user` |
| `SELECT 1::int, now()::timestamptz` | **no** `pg_catalog` relation (TypeName is not a RangeVar) |
| `SELECT` (invalid) | throws |

**Policy — same file**
| Case | Expect |
|---|---|
| `information_schema.tables`, `pg_catalog.pg_roles`, `pg_toast.x` | `BadRequestError` |
| unqualified `pg_tables`, `pg_settings`, `pg_stat_activity` | `BadRequestError` |
| `"tenant_b".t` with `allowedSchemas:['public']` | `ForbiddenError` (status 403) |
| `"tenant_b".t` with `allowedSchemas:['*']` | passes |
| `"pg_temp".t` with `allowedSchemas:['*']` | `BadRequestError` (system schema beats `'*'`) |
| `"user"` unqualified, `schema:'public'`, denied `['user']` | `BadRequestError` |
| `public."user"`, denied `['public.user']` | `BadRequestError` |
| `public."user"`, denied `['other.user']` | passes |
| `"USER"` / `U&"\0075ser"`, denied `['user']` | `BadRequestError` (case-insensitive + decoded) |
| denied table referenced only inside a CTE body / JOIN / subquery | `BadRequestError` |
| banned function via parser (`U&"…"` form) | `BadRequestError` |
| unparseable SQL | `BadRequestError` naming the parse failure |

**Service — `test/query-service.test.ts` (extend)**
- Rejected relation: throws, `stub.connectCount === 0`, exactly one `CapturingAudit` entry carrying the error text.
- 403 case surfaces `ForbiddenError` (`statusOf` → 403).
- `deniedTables` datasource variant via `makeConfig({ datasources:[{...base, deniedTables:['user'] }] })` + its own `PoolManager` (mirror the existing `unsafePools` pattern, `drainAll()` in `after`).
- `allowUnsafeStatements:true` datasource: `SELECT * FROM pg_tables` and `SELECT * FROM "user"` both reach the driver (guard skipped).
- Internal path: `qs.run({...}, { internalCatalogQuery: true, reason: 'introspection' })` with `SELECT * FROM information_schema.tables` reaches the driver.
- Normal reads (`SELECT id FROM t`, `WITH …`, `EXPLAIN …`, `VALUES (1)`) unchanged — txn wrap order assertions stay green.

**Transports — `test/routes.e2e.test.ts` + `test/mcp-tools.test.ts` (extend)**
- HTTP: `information_schema.tables` → 400; `SHOW all` → 400; `"tenant_b".t` with the RW token (`schemas:['public']`) → 403; `SELECT id FROM t` → 200 (unchanged).
- **Internal-flag unreachability (required):**
  ```ts
  // A caller must not be able to buy the introspection bypass by naming it.
  const res = await app.inject({ method: 'POST', url: '/query', headers: RO,
      payload: { datasource: 'main', sql: 'SELECT * FROM pg_tables', internalCatalogQuery: true, internal: { internalCatalogQuery: true } } });
  assert.equal(res.statusCode, 400);
  ```
  and the MCP twin via `fake.tools.get('run_query')!.handler({ datasource:'main', sql:'SELECT * FROM pg_tables', internalCatalogQuery:true })` → `isError`.
- MCP: `list_schemas` / `list_tables` / `describe_table` still return data (internal path).

**Regressions**
- `test/statement-guard.test.ts`: move `SHOW server_version` from `ok()` to `rejected()`; keep everything else.
- `test/introspect-service.test.ts`: unchanged and green.
- `test/assert-readonly-posture.test.ts`: probe still produces a verdict (not UNVERIFIED) with the guard on.
- `test/load-config.test.ts`: `DS_MAIN_DENIED_TABLES='user, public.role'` → `['user','public.role']`; unset → `[]`; `a.b.c` → `loadConfig()` throws.
- `test/sql-lexer.test.ts`, `test/single-statement.test.ts`: untouched.
- `test/integration/pg.integration.test.ts`: add (skipped without live PG) a denied-table + catalog rejection against real Postgres if the harness allows; otherwise note why not.

## Architecture
No production code in this phase. Fixture sketch for the denied-table service tests:

```ts
const deniedConfig = makeConfig({ datasources: [{ ...config.datasources[0], deniedTables: ['user', 'public.role'] }] });
const deniedPools = new PoolManager(deniedConfig.datasources, silentLogger);
after(() => deniedPools.drainAll());
const deniedSvc = (stub: StubDriver, audit = new CapturingAudit()) => ({
    qs: new QueryService(stub, deniedPools, config.maxRowsCeiling, audit), audit,
});

test('denied table is rejected before any DB contact and is audited', async () => {
    const stub = new StubDriver();
    const { qs, audit } = deniedSvc(stub);
    await assert.rejects(() => qs.run({ ...base, sql: 'SELECT * FROM "user"', write: false, allowedSchemas: ['*'] }), BadRequestError);
    assert.equal(stub.connectCount, 0);
    assert.equal(audit.entries.length, 1);
    assert.match(String(audit.entries[0].error), /denied-table list/);
});
```

## Related Code Files
- **Create:** `test/relation-guard.test.ts`
- **Modify:** `test/query-service.test.ts`, `test/routes.e2e.test.ts`, `test/mcp-tools.test.ts`, `test/statement-guard.test.ts`, `test/load-config.test.ts`, `test/integration/pg.integration.test.ts` (optional case)
- **Read for context:** `test/helpers.ts`, `test/introspect-service.test.ts`, `test/assert-readonly-posture.test.ts`

## Implementation Steps
1. Write `test/relation-guard.test.ts` covering both matrices (extraction first, then policy) with `ok`/`rejected` helpers in the local style.
2. Extend `query-service.test.ts` with the denied/unsafe/internal-path fixtures and the no-DB-contact + audit assertions.
3. Extend the two transport suites, including the internal-flag unreachability pair.
4. Flip the `SHOW` case in `statement-guard.test.ts`; add the `load-config` denied-table cases.
5. Run `npm test`; triage every failure — fix **source** only if the source is wrong, otherwise fix the fixture (unparseable/placeholder SQL).
6. `npm run typecheck` clean. Report final pass/skip/fail counts in the plan's completion note.

## Todo List
- [ ] `test/relation-guard.test.ts` — extraction matrix
- [ ] `test/relation-guard.test.ts` — policy matrix (incl. 403 + unicode + CTE shadow both directions)
- [ ] `query-service.test.ts` — denied / unsafe-skip / internal-path / audit / `connectCount === 0`
- [ ] `routes.e2e.test.ts` + `mcp-tools.test.ts` — rejections, 403, discovery still works
- [ ] Internal-flag unreachability proven over HTTP **and** MCP
- [ ] `SHOW` regression flipped; `load-config` denied-table parsing cases
- [ ] Full suite green; typecheck clean; counts recorded

## Success Criteria
- Every brainstorm success-criteria bullet has at least one asserting test.
- `npm test` green: previous baseline (132 pass / 12 skipped) plus the new cases, **0 fail**.
- No test weakens an existing assertion to pass; no mock hides a real rejection path.
- Guard rejections assert *both* the error type and `connectCount === 0`.

## Risk Assessment
| Risk | L×I | Mitigation |
|---|---|---|
| Fixture SQL elsewhere in the suite is not parseable → surprise reds | Med × Low | Step 5 triage; fixtures are placeholders, fixing them is legitimate |
| Async guard turns previously-sync throws into rejected promises | Med × Med | Use `assert.rejects` for all guard paths |
| Live-PG integration cases silently skipped in CI | High × Low | Keep them skipped-by-default (existing convention) and rely on stub-driver coverage for the guard itself |
| Test-only `deniedTables` pools leak connections | Low × Low | `after(() => pools.drainAll())` per the existing pattern |

## Security Considerations
- The internal-flag unreachability test is the highest-value test in this plan: it is the one bug that would convert the whole guard into a no-op for an attacker who reads the source.
- Assert audit entries exist for blocked attempts — a silent block is a monitoring gap.
- Do not add a test-only bypass or env flag; the escape hatch is the only opt-out and it is per-datasource config.

## Next Steps
- Phase 05 documents the shipped posture, the `.env` list, and the two user-only actions.
