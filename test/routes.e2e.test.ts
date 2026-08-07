import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServices } from '../src/services.js';
import { buildApp } from '../src/build-app.js';
import { makeConfig, silentLogger, StubDriver } from './helpers.js';

// Disable health-check caching so the degraded test observes a fresh ping result.
process.env.HEALTH_CACHE_TTL_MS = '0';
const stub = new StubDriver();
const services = buildServices(makeConfig(), silentLogger, stub);
let app: FastifyInstance;

const RO = { authorization: 'Bearer ro-secret' };
const RW = { authorization: 'Bearer rw-secret' };

before(async () => {
    app = buildApp(services);
    await app.ready();
});
after(async () => {
    await app.close();
    await services.pools.drainAll();
});

test('POST /query — 200 happy path returns the neutral shape', async () => {
    stub.userResult = { fields: [{ name: 'id', dataType: 'uuid' }], rows: [{ id: 'a' }], rowCount: 1, command: 'SELECT' };
    const res = await app.inject({ method: 'POST', url: '/query', headers: RO, payload: { datasource: 'main', sql: 'SELECT id FROM t' } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.columns, [{ name: 'id', dataType: 'uuid' }]);
    assert.equal(body.rowCount, 1);
    assert.equal(body.truncated, false);
    assert.equal(typeof body.elapsedMs, 'number');
});

test('POST /query — 400 malformed (missing sql)', async () => {
    const res = await app.inject({ method: 'POST', url: '/query', headers: RO, payload: { datasource: 'main' } });
    assert.equal(res.statusCode, 400);
});

test('POST /query — 401 without a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/query', payload: { datasource: 'main', sql: 'SELECT 1' } });
    assert.equal(res.statusCode, 401);
});

test('POST /query — 403 write with a read-only token', async () => {
    const res = await app.inject({ method: 'POST', url: '/query', headers: RO, payload: { datasource: 'main', sql: 'INSERT INTO t VALUES (1)', readOnly: false } });
    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /write-not-permitted/);
});

test('POST /query — write token + readOnly:false to allowed schema → 200 rowsAffected', async () => {
    stub.userResult = { fields: [], rows: [], rowCount: 1, command: 'INSERT' };
    const res = await app.inject({
        method: 'POST',
        url: '/query',
        headers: RW,
        payload: { datasource: 'main', schema: 'public', sql: 'INSERT INTO t VALUES (1)', readOnly: false },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().rowsAffected, 1);
});

test('POST /query — write token to disallowed schema → 403', async () => {
    const res = await app.inject({
        method: 'POST',
        url: '/query',
        headers: RW,
        payload: { datasource: 'main', schema: 'tenant_x', sql: 'INSERT INTO t VALUES (1)', readOnly: false },
    });
    assert.equal(res.statusCode, 403);
});

test('POST /query — datasource outside caps → 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/query', headers: RW, payload: { datasource: 'ghost', sql: 'SELECT 1' } });
    assert.equal(res.statusCode, 403);
});

// ── relation guard over HTTP ────────────────────────────────────────────────────

test('POST /query — catalog read (information_schema) → 400', async () => {
    const res = await app.inject({
        method: 'POST',
        url: '/query',
        headers: RO,
        payload: { datasource: 'main', sql: 'SELECT * FROM information_schema.tables' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /not readable through run_query/);
});

test('POST /query — SHOW is no longer allowed → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/query', headers: RO, payload: { datasource: 'main', sql: 'SHOW all' } });
    assert.equal(res.statusCode, 400);
});

test('POST /query — schema-restricted token reading another schema → 403', async () => {
    // RW is scoped to schemas:['public']; a qualified cross-schema ref is a caps violation.
    const res = await app.inject({
        method: 'POST',
        url: '/query',
        headers: RW,
        payload: { datasource: 'main', sql: 'SELECT * FROM "tenant_b".t' },
    });
    assert.equal(res.statusCode, 403);
});

// The single most important test in the plan: a caller must not be able to BUY the
// introspection bypass by naming the internal trust flag in the request body. The zod
// schema strips unknown keys, and the flag is a second positional arg to run() — it
// can never be carried by a JSON body.
test('POST /query — naming the internal trust flag in the body does NOT bypass the guard', async () => {
    const res = await app.inject({
        method: 'POST',
        url: '/query',
        headers: RO,
        payload: {
            datasource: 'main',
            sql: 'SELECT * FROM pg_tables',
            internalCatalogQuery: true,
            internal: { internalCatalogQuery: true, reason: 'introspection' },
        },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /not readable through run_query/);
});

test('GET /health — ok shape when pools answer', async () => {
    stub.pingError = null;
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.datasources[0].name, 'main');
    assert.equal(body.datasources[0].ok, true);
    assert.equal(typeof body.datasources[0].poolSize, 'number');
});

test('GET /health — 503 degraded when a pool ping fails', async () => {
    stub.pingError = new Error('down');
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().status, 'degraded');
    stub.pingError = null;
});

test('GET /datasources — lists caps-visible datasources (auth)', async () => {
    const res = await app.inject({ method: 'GET', url: '/datasources', headers: RO });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), [{ name: 'main', defaultSchema: 'public' }]);
});

test('GET /datasources — 401 without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/datasources' });
    assert.equal(res.statusCode, 401);
});

test('POST /introspect/tables — 200 happy', async () => {
    stub.userResult = { fields: [], rows: [{ table_name: 't1', table_type: 'BASE TABLE' }], rowCount: 1, command: 'SELECT' };
    const res = await app.inject({ method: 'POST', url: '/introspect/tables', headers: RO, payload: { datasource: 'main', schema: 'public' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { tables: [{ name: 't1', type: 'BASE TABLE' }] });
});

test('POST /introspect/schemas — 200 filtered', async () => {
    stub.userResult = { fields: [], rows: [{ schema_name: 'public' }, { schema_name: 'pg_catalog' }], rowCount: 2, command: 'SELECT' };
    const res = await app.inject({ method: 'POST', url: '/introspect/schemas', headers: RO, payload: { datasource: 'main' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { schemas: ['public'] });
});

test('POST /introspect/describe — 403 for a disallowed schema', async () => {
    const res = await app.inject({ method: 'POST', url: '/introspect/describe', headers: RW, payload: { datasource: 'main', schema: 'tenant_x', table: 't' } });
    assert.equal(res.statusCode, 403);
});

test('POST /introspect/tables — 401 without a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/introspect/tables', payload: { datasource: 'main', schema: 'public' } });
    assert.equal(res.statusCode, 401);
});
