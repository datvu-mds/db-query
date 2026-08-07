/**
 * Real-Postgres integration tests. SKIPPED unless a test DB is configured via
 * PGCP_TEST_* (falls back to the DATABASE_* vars). These validate the
 * behaviors that cannot be proven against a stub:
 *   - P0 tenant isolation: SET LOCAL search_path targets the right schema and
 *     resets on COMMIT (no cross-tenant leak on a reused pooled connection).
 *   - engine-level read-only enforcement (write in a READ ONLY txn is rejected).
 *   - statement_timeout fires; pool ping / drain; write commit + rollback.
 *
 * Run:  PGCP_TEST_HOST=localhost PGCP_TEST_USER=postgres PGCP_TEST_PASSWORD=postgres \
 *       PGCP_TEST_DATABASE=postgres npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PoolManager } from '../../src/pool/pool-manager.js';
import { PostgresDriver } from '../../src/driver/postgres-driver.js';
import { QueryService } from '../../src/query/query-service.js';
import { IntrospectService } from '../../src/introspect/introspect-service.js';
import type { DatasourceConfig } from '../../src/config/config.schema.js';
import { BadRequestError, ServiceUnavailableError } from '../../src/query/gateway-errors.js';
import { silentLogger, CapturingAudit } from '../helpers.js';

const HOST = process.env.PGCP_TEST_HOST ?? process.env.DATABASE_HOST;
const RUN = Boolean(HOST);
const opts = { skip: RUN ? false : 'no test Postgres configured (set PGCP_TEST_HOST or DATABASE_HOST)' };

const SCHEMA_A = 'pgcp_test_a';
const SCHEMA_B = 'pgcp_test_b';

function dsConfig(poolMax: number): DatasourceConfig {
    return {
        name: 'main',
        host: HOST as string,
        port: Number(process.env.PGCP_TEST_PORT ?? process.env.DATABASE_PORT ?? 5432),
        user: process.env.PGCP_TEST_USER ?? process.env.DATABASE_USERNAME ?? 'postgres',
        password: process.env.PGCP_TEST_PASSWORD ?? process.env.DATABASE_PASSWORD ?? 'postgres',
        database: process.env.PGCP_TEST_DATABASE ?? process.env.DATABASE_NAME ?? 'postgres',
        ssl: (process.env.PGCP_TEST_SSL ?? process.env.DATABASE_SSL) === 'true',
        defaultSchema: 'public',
        poolMax,
        statementTimeoutMs: 10000,
        idleTimeoutMs: 10000,
        connectionTimeoutMs: 5000,
        maxUses: 7500,
        // These tests prove ENGINE-level guarantees — the read-only txn rejecting a
        // write, DISCARD ALL scrubbing a plain SET, statement_timeout firing — which
        // requires those statements to REACH the engine. The app-layer statement
        // guard would otherwise 400 them first, so it is deliberately disabled here.
        // (The guard has its own coverage in query-service/statement-guard tests.)
        allowUnsafeStatements: true,
    };
}

let pools: PoolManager;
let qs: QueryService;
let introspect: IntrospectService;

// A second stack with the relation guard ENFORCED (allowUnsafeStatements:false) and a
// denied-table list, so we can prove the wired guard against real Postgres.
let guardedPools: PoolManager;
let guardedQs: QueryService;

before(async () => {
    if (!RUN) return;
    // Test fixtures via a DIRECT client (DDL is not part of the gateway's surface).
    const cfg = dsConfig(1);
    const admin = new pg.Pool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA_A} CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA_B} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA_A}`);
    await admin.query(`CREATE SCHEMA ${SCHEMA_B}`);
    await admin.query(`CREATE TABLE ${SCHEMA_A}.t (id int)`);
    await admin.query(`CREATE TABLE ${SCHEMA_B}.t (id int)`);
    await admin.query(`INSERT INTO ${SCHEMA_A}.t (id) VALUES (1)`);
    await admin.query(`INSERT INTO ${SCHEMA_B}.t (id) VALUES (2)`);
    await admin.end();

    // pool max=1 forces the SAME backend to be reused across queries → the real
    // cross-tenant-leak scenario.
    pools = new PoolManager([dsConfig(1)], silentLogger);
    const driver = new PostgresDriver(pools);
    qs = new QueryService(driver, pools, 10000, new CapturingAudit());
    introspect = new IntrospectService(qs, pools);

    guardedPools = new PoolManager([{ ...dsConfig(1), allowUnsafeStatements: false, deniedTables: ['secret'] }], silentLogger);
    guardedQs = new QueryService(new PostgresDriver(guardedPools), guardedPools, 10000, new CapturingAudit());
});

after(async () => {
    if (!RUN) return;
    const cfg = dsConfig(1);
    const admin = new pg.Pool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA_A} CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA_B} CASCADE`);
    await admin.end();
    await pools.drainAll();
    await guardedPools.drainAll();
});

test('P0: reused pooled connection targets the right tenant schema (no leak)', opts, async () => {
    const a = await qs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_A, sql: 'SELECT id FROM t', write: false });
    assert.deepEqual(a.response.rows, [{ id: 1 }]);
    // Same backend (max=1) reused; schema B must return B's data, never A's.
    const b = await qs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_B, sql: 'SELECT id FROM t', write: false });
    assert.deepEqual(b.response.rows, [{ id: 2 }]);
});

test('P0: SET LOCAL resets search_path on COMMIT (raw-connection proof)', opts, async () => {
    const pool = pools.getPool('main');
    const client = await pool.connect();
    try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        await client.query(`SET LOCAL search_path TO ${SCHEMA_A}`);
        const inside = await client.query('SHOW search_path');
        assert.match(String(inside.rows[0].search_path), new RegExp(SCHEMA_A));
        await client.query('COMMIT');
        // After COMMIT the LOCAL setting is gone → back to the session default.
        const after = await client.query('SHOW search_path');
        assert.doesNotMatch(String(after.rows[0].search_path), new RegExp(SCHEMA_A));
    } finally {
        client.release();
    }
});

test('engine rejects a write in a read-only transaction', opts, async () => {
    await assert.rejects(
        () => qs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_A, sql: 'INSERT INTO t (id) VALUES (99)', write: false }),
        /read-only transaction/i,
    );
    // The rejected write left no data.
    const check = await qs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_A, sql: 'SELECT count(*)::int AS n FROM t', write: false });
    assert.equal(check.response.rows[0].n, 1);
});

test('statement_timeout fires on a slow query', opts, async () => {
    await assert.rejects(
        () => qs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_A, sql: 'SELECT pg_sleep(1)', write: false, timeoutMs: 100 }),
        /statement timeout/i,
    );
});

test('write path commits and reports rowsAffected', opts, async () => {
    const w = await qs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_B, sql: 'INSERT INTO t (id) VALUES (3)', write: true });
    assert.equal(w.response.rowsAffected, 1);
    const check = await qs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_B, sql: 'SELECT count(*)::int AS n FROM t', write: false });
    assert.equal(check.response.rows[0].n, 2);
});

test('failed write rolls back with no partial data', opts, async () => {
    await assert.rejects(() => qs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_B, sql: 'INSERT INTO t (id) VALUES (nonexistent_col)', write: true }));
    const check = await qs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_B, sql: 'SELECT count(*)::int AS n FROM t', write: false });
    assert.equal(check.response.rows[0].n, 2); // unchanged from previous test's commit
});

/**
 * Security regressions. The unit tests prove we ASK for the right behavior
 * (queryMode:'extended', a DISCARD ALL exec); only a real server proves it
 * actually holds. Both of these were live exploits before the fix.
 */
test('SECURITY: the server itself rejects multi-statement text', opts, async () => {
    // Straight to the driver, bypassing assertSingleStatement, so the ONLY thing
    // that can reject this is the extended wire protocol. Under the simple protocol
    // this ran both statements happily.
    const driver = new PostgresDriver(pools);
    const conn = await driver.connect('main');
    try {
        await assert.rejects(() => conn.exec('SELECT 1; SELECT 2'), /cannot insert multiple commands/i);
    } finally {
        conn.release();
    }
});

test('SECURITY: a read-only token cannot COMMIT its way out of the read-only txn', opts, async () => {
    // The original exploit: E'\'' left the text scanner believing the literal was
    // still open, smuggling a COMMIT that ended the READ ONLY transaction and left
    // the caller in a read-write session.
    await assert.rejects(
        () =>
            qs.run({
                tokenId: 't',
                datasource: 'main',
                schema: SCHEMA_A,
                sql: "SELECT E'\\''; COMMIT; INSERT INTO t (id) VALUES (666)",
                write: false,
            }),
        /Multiple SQL statements|cannot insert multiple commands/i,
    );
    const check = await qs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_A, sql: 'SELECT count(*)::int AS n FROM t', write: false });
    assert.equal(check.response.rows[0].n, 1); // no smuggled insert landed
});

test('SECURITY: caller session state does not survive to the next borrower', opts, async () => {
    // pool max=1 → the next run is guaranteed the same backend. A plain SET (not
    // SET LOCAL) survives COMMIT, so without DISCARD ALL the next caller inherits
    // it — e.g. `SET statement_timeout = 0` disabling the timeout guardrail.
    await qs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_A, sql: "SET application_name = 'pgcp_leak_probe'", write: false });
    const next = await qs.run({
        tokenId: 't',
        datasource: 'main',
        schema: SCHEMA_A,
        sql: "SELECT current_setting('application_name') AS a",
        write: false,
    });
    assert.notEqual(next.response.rows[0].a, 'pgcp_leak_probe');
});

test('SECURITY: pg_temp is last on search_path, so temp tables cannot shadow tenant tables', opts, async () => {
    const sp = await qs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_A, sql: 'SHOW search_path', write: false });
    assert.match(String(sp.response.rows[0].search_path), /pg_temp\s*$/);
});

test('introspection returns real structure through the guarded path', opts, async () => {
    const tables = await introspect.listTables('t', 'main', SCHEMA_A);
    assert.ok(tables.some((t) => t.name === 't'));
    const cols = await introspect.describeTable('t', 'main', SCHEMA_A, 't');
    assert.equal(cols[0].name, 'id');
});

test('pool ping succeeds and drain ends pools', opts, async () => {
    await pools.ping('main');
    // (drainAll is exercised in `after`; ping proves the pool is live)
});

// ── relation guard on a real server (guard ENFORCED datasource) ──────────────────

test('SECURITY: the wired relation guard rejects a catalog read against real Postgres', opts, async () => {
    await assert.rejects(
        () => guardedQs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_A, sql: 'SELECT * FROM information_schema.tables', write: false, allowedSchemas: ['*'] }),
        (e) => e instanceof BadRequestError,
    );
});

test('SECURITY: the wired relation guard rejects a denied table before DB contact', opts, async () => {
    // `secret` need not exist — the guard rejects pre-connect, purely from the parse tree.
    await assert.rejects(
        () => guardedQs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_A, sql: 'SELECT * FROM secret', write: false, allowedSchemas: ['*'] }),
        (e) => e instanceof BadRequestError,
    );
});

test('the guard permits an ordinary tenant read (real row returned)', opts, async () => {
    const r = await guardedQs.run({ tokenId: 't', datasource: 'main', schema: SCHEMA_A, sql: 'SELECT id FROM t', write: false, allowedSchemas: ['*'] });
    assert.deepEqual(r.response.rows, [{ id: 1 }]);
});
