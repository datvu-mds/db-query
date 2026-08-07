import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSqlRefs, assertRelationsAllowed, isSystemSchema, type RelationPolicy } from '../src/query/relation-guard.js';
import { BadRequestError, ForbiddenError } from '../src/query/gateway-errors.js';

// ── Extraction ──────────────────────────────────────────────────────────────────
// extractSqlRefs returns every referenced relation (CTE-aware, decoded) + function
// name. Schema is undefined when the ref is unqualified.

const rels = async (sql: string) => (await extractSqlRefs(sql)).relations;
const fns = async (sql: string) => (await extractSqlRefs(sql)).functions;

test('collects relations across FROM / qualified / JOIN, preserving schemas', async () => {
    assert.deepEqual(await rels('SELECT * FROM a'), [{ schema: undefined, relation: 'a' }]);
    assert.deepEqual(await rels('SELECT * FROM s.b'), [{ schema: 's', relation: 'b' }]);
    assert.deepEqual(await rels('SELECT * FROM a JOIN s.b ON true JOIN c ON true'), [
        { schema: undefined, relation: 'a' },
        { schema: 's', relation: 'b' },
        { schema: undefined, relation: 'c' },
    ]);
});

test('collects relations inside subqueries (FROM, scalar SELECT, IN)', async () => {
    const fromSub = (await rels('SELECT * FROM (SELECT * FROM inner_t) x')).map((r) => r.relation);
    assert.ok(fromSub.includes('inner_t'));
    const scalar = (await rels('SELECT (SELECT max(v) FROM sub_t) FROM main_t')).map((r) => r.relation);
    assert.deepEqual(scalar.sort(), ['main_t', 'sub_t']);
    const inList = (await rels('SELECT * FROM t WHERE id IN (SELECT id FROM other_t)')).map((r) => r.relation);
    assert.deepEqual(inList.sort(), ['other_t', 't']);
});

test('CTE names are not relations (legit shadow)', async () => {
    assert.deepEqual(await rels('WITH t AS (SELECT 1) SELECT * FROM t'), []);
    assert.deepEqual(await rels('WITH "user" AS (SELECT 1) SELECT * FROM "user"'), []);
});

test('a later CTE name does NOT mask a real table referenced earlier', async () => {
    // WITH a AS (SELECT * FROM "user"), "user" AS (SELECT 1) SELECT * FROM a
    // The real `user` table inside a's body must be collected — the later CTE named
    // "user" is out of scope there. This is the subtlest bypass to regress.
    const r = await rels('WITH a AS (SELECT * FROM "user"), "user" AS (SELECT 1) SELECT * FROM a');
    assert.ok(
        r.some((x) => x.relation === 'user' && x.schema === undefined),
        `expected real "user" table, got ${JSON.stringify(r)}`,
    );
});

test('RECURSIVE self-reference is not a relation', async () => {
    assert.deepEqual(await rels('WITH RECURSIVE r AS (SELECT 1 UNION ALL SELECT * FROM r) SELECT * FROM r'), []);
});

test('EXPLAIN walks its inner query', async () => {
    assert.deepEqual(await rels('EXPLAIN SELECT * FROM t'), [{ schema: undefined, relation: 't' }]);
    assert.deepEqual(await rels('EXPLAIN (FORMAT JSON) SELECT * FROM s.t'), [{ schema: 's', relation: 't' }]);
});

test('relation-free statements yield no relations and do not throw', async () => {
    assert.deepEqual(await rels('VALUES (1)'), []);
    assert.deepEqual(await rels('SELECT 1'), []);
});

test('identifier case is preserved as written', async () => {
    assert.deepEqual(await rels('SELECT * FROM "MixedCase".t'), [{ schema: 'MixedCase', relation: 't' }]);
    assert.deepEqual(await rels('SELECT * FROM "User"'), [{ schema: undefined, relation: 'User' }]);
});

test('unicode-escaped identifiers are decoded (the whole reason for the parser)', async () => {
    assert.ok((await fns(`SELECT U&"\\0070g_read_file"('/x')`)).includes('pg_read_file'));
    assert.deepEqual(await rels('SELECT * FROM U&"\\0075ser"'), [{ schema: undefined, relation: 'user' }]);
});

test('a ::type cast does not surface pg_catalog as a relation (TypeName is not a RangeVar)', async () => {
    assert.deepEqual(await rels('SELECT 1::int, now()::timestamptz'), []);
});

test('unparseable SQL throws', async () => {
    // NB: bare `SELECT` is accepted by pg18 (empty SelectStmt); `SELECT * FROM` is not.
    await assert.rejects(() => extractSqlRefs('SELECT * FROM'));
    await assert.rejects(() => extractSqlRefs(')('));
});

// The parser emits INSERT/UPDATE/DELETE/MERGE targets and `SELECT … INTO` as BARE
// (untagged) RangeVars, so the walker must collect them by shape or a write-mode token
// could write cross-tenant / to a denied table unpoliced. These are that regression net.
test('write/create TARGET relations are collected (INSERT/UPDATE/DELETE/MERGE/SELECT INTO)', async () => {
    assert.deepEqual(await rels('INSERT INTO t VALUES (1)'), [{ schema: undefined, relation: 't' }]);
    assert.deepEqual(await rels('INSERT INTO tenant_b.customers VALUES (1)'), [{ schema: 'tenant_b', relation: 'customers' }]);
    assert.deepEqual(await rels('DELETE FROM secret_audit WHERE id = 1'), [{ schema: undefined, relation: 'secret_audit' }]);
    assert.deepEqual(await rels('UPDATE s.t SET x = 1'), [{ schema: 's', relation: 't' }]);
    // targets AND read-side relations both collected
    assert.deepEqual((await rels('UPDATE t SET x = 1 FROM other o WHERE o.id = t.id')).map((r) => r.relation).sort(), ['other', 't']);
    assert.deepEqual((await rels('DELETE FROM t USING logs l WHERE l.id = t.id')).map((r) => r.relation).sort(), ['logs', 't']);
    assert.deepEqual((await rels('MERGE INTO tgt t USING src s ON t.id = s.id WHEN MATCHED THEN DELETE')).map((r) => r.relation).sort(), ['src', 'tgt']);
    assert.deepEqual((await rels('SELECT * INTO tenant_b.newt FROM src')).map((r) => r.relation).sort(), ['newt', 'src']);
});

test('a write TARGET named like an in-scope CTE is still collected (not masked)', async () => {
    // You cannot INSERT into a CTE, so `"user"` here is the real table despite the CTE name.
    const r = await rels('WITH "user" AS (SELECT 1) INSERT INTO "user" VALUES (1)');
    assert.ok(r.some((x) => x.relation === 'user' && x.schema === undefined), JSON.stringify(r));
});

// ── Policy ──────────────────────────────────────────────────────────────────────

const policy = (over: Partial<RelationPolicy> = {}): RelationPolicy => ({
    schema: 'public',
    allowedSchemas: ['*'],
    deniedTables: [],
    ...over,
});
const rejects400 = (sql: string, p = policy()) =>
    assert.rejects(() => assertRelationsAllowed(sql, p), (e) => e instanceof BadRequestError, sql);
const rejects403 = (sql: string, p = policy()) =>
    assert.rejects(() => assertRelationsAllowed(sql, p), (e) => e instanceof ForbiddenError, sql);
const allows = (sql: string, p = policy()) => assert.doesNotReject(() => assertRelationsAllowed(sql, p), sql);

test('isSystemSchema matches pg_* and information_schema, case-insensitively', () => {
    for (const n of ['pg_catalog', 'pg_toast', 'pg_temp_3', 'information_schema', 'INFORMATION_SCHEMA', 'PG_CATALOG']) {
        assert.equal(isSystemSchema(n), true, n);
    }
    for (const n of ['public', 'tenant_a', 'pgx', 'my_pg']) assert.equal(isSystemSchema(n), false, n);
});

test('policy: qualified system-schema relations → 400 (metadata block)', async () => {
    await rejects400('SELECT * FROM information_schema.tables');
    await rejects400('SELECT * FROM pg_catalog.pg_roles');
    await rejects400('SELECT * FROM pg_toast.x');
});

test('policy: unqualified pg_% relations → 400 (implicit pg_catalog resolution)', async () => {
    await rejects400('SELECT * FROM pg_tables');
    await rejects400('SELECT * FROM pg_settings');
    await rejects400('SELECT * FROM pg_stat_activity');
});

test('policy: qualified cross-schema outside caps → 403; within caps or wildcard → allowed', async () => {
    await rejects403('SELECT * FROM "tenant_b".t', policy({ allowedSchemas: ['public'] }));
    await allows('SELECT * FROM "tenant_b".t', policy({ allowedSchemas: ['*'] }));
    await allows('SELECT * FROM "public".t', policy({ allowedSchemas: ['public'] }));
});

test('policy: a system schema beats a wildcard cap', async () => {
    await rejects400('SELECT * FROM "pg_temp".t', policy({ allowedSchemas: ['*'] }));
});

test('policy: denied tables — bare matches any schema, schema.table is exact, case-insensitive', async () => {
    await rejects400('SELECT * FROM "user"', policy({ schema: 'public', deniedTables: ['user'] }));
    await rejects400('SELECT * FROM public."user"', policy({ deniedTables: ['public.user'] }));
    await allows('SELECT * FROM public."user"', policy({ deniedTables: ['other.user'] }));
    await rejects400('SELECT * FROM "USER"', policy({ schema: 'public', deniedTables: ['user'] }));
    await rejects400('SELECT * FROM U&"\\0075ser"', policy({ schema: 'public', deniedTables: ['user'] }));
});

test('policy: a denied table referenced only in a CTE body / JOIN / subquery is still caught', async () => {
    await rejects400('WITH x AS (SELECT * FROM "user") SELECT * FROM x', policy({ deniedTables: ['user'] }));
    await rejects400('SELECT * FROM t JOIN "user" u ON true', policy({ deniedTables: ['user'] }));
    await rejects400('SELECT * FROM t WHERE id IN (SELECT id FROM "user")', policy({ deniedTables: ['user'] }));
});

test('policy: a banned function reached via the parser (unicode form) → 400', async () => {
    await rejects400(`SELECT U&"\\0070g_read_file"('/etc/passwd')`);
    await rejects400(`SELECT pg_catalog.pg_terminate_backend(1)`);
});

test('policy: unparseable SQL → 400 naming the parse failure (fail-closed)', async () => {
    await assert.rejects(
        () => assertRelationsAllowed('SELECT * FROM', policy()),
        (e) => e instanceof BadRequestError && /could not be parsed/.test((e as Error).message),
    );
});

test('policy: ordinary tenant reads pass unchanged', async () => {
    await allows('SELECT id FROM t JOIN u ON t.id = u.id', policy({ schema: 'public', allowedSchemas: ['public'] }));
    await allows('WITH c AS (SELECT 1) SELECT * FROM c', policy({ allowedSchemas: ['public'] }));
    await allows('EXPLAIN SELECT * FROM t', policy({ allowedSchemas: ['public'] }));
    await allows('VALUES (1)');
});

test('policy: write/create TARGETS are policed against caps and the denylist', async () => {
    const scoped = policy({ schema: 'tenant_a', allowedSchemas: ['tenant_a'], deniedTables: ['secret_audit'] });
    // denied target (unqualified → effective schema tenant_a)
    await rejects400('DELETE FROM secret_audit WHERE id = 1', scoped);
    await rejects400('UPDATE secret_audit SET x = 1', scoped);
    await rejects400('INSERT INTO secret_audit VALUES (1)', scoped);
    await rejects400('MERGE INTO secret_audit t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', scoped);
    // cross-tenant target outside caps
    await rejects403('INSERT INTO tenant_b.customers VALUES (1)', scoped);
    await rejects403('UPDATE tenant_b.customers SET x = 1', scoped);
    await rejects403('SELECT * INTO tenant_b.newt FROM src', scoped);
    // a CTE-named target on the denylist is still blocked (CTE does not mask it)
    await rejects400('WITH "user" AS (SELECT 1) INSERT INTO "user" VALUES (1)', policy({ schema: 'tenant_a', allowedSchemas: ['tenant_a'], deniedTables: ['user'] }));
    // legitimate own-tenant write still passes (qualified and unqualified)
    await allows('INSERT INTO tenant_a.orders VALUES (1)', scoped);
    await allows('INSERT INTO orders VALUES (1)', scoped);
});
