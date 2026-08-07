import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolManager } from '../src/pool/pool-manager.js';
import { QueryService } from '../src/query/query-service.js';
import { BadRequestError, ForbiddenError, ServiceUnavailableError } from '../src/query/gateway-errors.js';
import { makeConfig, silentLogger, StubDriver, CapturingAudit } from './helpers.js';

const config = makeConfig();
const pools = new PoolManager(config.datasources, silentLogger);

// A second pool whose only datasource has the statement-guard escape hatch ON.
// Same logical name ('main') so `base.datasource` works unchanged; getConfig now
// returns allowUnsafeStatements:true, so the guard is skipped.
const unsafeConfig = makeConfig({
    datasources: [{ ...config.datasources[0], allowUnsafeStatements: true }],
});
const unsafePools = new PoolManager(unsafeConfig.datasources, silentLogger);

// A third pool whose 'main' datasource carries a denied-table list, so the relation
// guard rejects those relations (same-name datasource keeps `base` unchanged).
const deniedConfig = makeConfig({
    datasources: [{ ...config.datasources[0], deniedTables: ['user', 'public.role'] }],
});
const deniedPools = new PoolManager(deniedConfig.datasources, silentLogger);
after(() => {
    pools.drainAll();
    unsafePools.drainAll();
    deniedPools.drainAll();
});

function svc(stub: StubDriver, audit: CapturingAudit = new CapturingAudit(), ceiling = config.maxRowsCeiling) {
    return { qs: new QueryService(stub, pools, ceiling, audit), audit };
}

/** QueryService whose datasource has allowUnsafeStatements:true (guard skipped). */
function unsafeSvc(stub: StubDriver, audit: CapturingAudit = new CapturingAudit()) {
    return { qs: new QueryService(stub, unsafePools, config.maxRowsCeiling, audit), audit };
}

/** QueryService whose datasource carries deniedTables (relation guard enforced). */
function deniedSvc(stub: StubDriver, audit: CapturingAudit = new CapturingAudit()) {
    return { qs: new QueryService(stub, deniedPools, config.maxRowsCeiling, audit), audit };
}

const base = { tokenId: 't', datasource: 'main', schema: 'public' as string };

test('read path: BEGIN READ ONLY → SET LOCAL ×3 → sql → COMMIT → DISCARD ALL, released once', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run({ ...base, sql: 'SELECT 1', write: false });
    const sqls = stub.sqls();
    assert.equal(sqls[0], 'BEGIN TRANSACTION READ ONLY');
    assert.match(sqls[1], /^SET LOCAL statement_timeout TO \d+$/);
    assert.match(sqls[2], /^SET LOCAL idle_in_transaction_session_timeout TO \d+$/);
    assert.equal(sqls[3], 'SET LOCAL search_path TO "public", pg_temp');
    assert.equal(sqls[4], 'SELECT 1');
    assert.equal(sqls[5], 'COMMIT');
    assert.equal(sqls[6], 'DISCARD ALL');
    assert.equal(stub.released, 1);
});

test('search_path names pg_temp last so temp tables cannot shadow the tenant schema', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run({ ...base, schema: 'tenant_a', sql: 'SELECT 1', write: false });
    assert.ok(stub.sqls().includes('SET LOCAL search_path TO "tenant_a", pg_temp'));
});

test('scrubs session state with DISCARD ALL after COMMIT, outside the txn', async () => {
    const stub = new StubDriver();
    // A plain SET is now blocked by the statement guard on a normal datasource, so
    // the scenario it protects (a caller's SET surviving COMMIT) only reaches the DB
    // on an escape-hatch datasource — run it there; DISCARD ALL is what stops the
    // next borrower inheriting it.
    const { qs } = unsafeSvc(stub);
    await qs.run({ ...base, sql: 'SET statement_timeout = 0', write: false });
    const sqls = stub.sqls();
    assert.ok(sqls.indexOf('DISCARD ALL') > sqls.indexOf('COMMIT'));
});

test('scrubs session state on the write path too', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run({ ...base, sql: 'INSERT INTO t VALUES (1)', write: true });
    assert.ok(stub.sqls().includes('DISCARD ALL'));
});

test('scrubs session state after a failed query (post-ROLLBACK)', async () => {
    const stub = new StubDriver();
    stub.userError = new Error('boom');
    const { qs } = svc(stub);
    await assert.rejects(() => qs.run({ ...base, sql: 'SELECT bad', write: false }), /boom/);
    const sqls = stub.sqls();
    assert.ok(sqls.indexOf('DISCARD ALL') > sqls.indexOf('ROLLBACK'));
    assert.equal(stub.releaseErrors[0], undefined); // clean scrub → safe to reuse
});

test('destroys the connection when DISCARD ALL fails (state unknown)', async () => {
    const stub = new StubDriver();
    stub.discardError = new Error('discard boom');
    const { qs } = svc(stub);
    await qs.run({ ...base, sql: 'SELECT 1', write: false }); // query itself still succeeds
    assert.equal(stub.released, 1);
    assert.ok(stub.releaseErrors[0]); // released WITH an error → pg destroys the client
});

test('skips DISCARD ALL when ROLLBACK already failed (connection is being destroyed)', async () => {
    const stub = new StubDriver();
    stub.userError = new Error('query boom');
    stub.rollbackError = new Error('rollback boom');
    const { qs } = svc(stub);
    await assert.rejects(() => qs.run({ ...base, sql: 'SELECT 1', write: false }), /query boom/);
    assert.ok(!stub.sqls().includes('DISCARD ALL'));
    assert.ok(stub.releaseErrors[0]);
});

test('write path uses plain BEGIN and surfaces rowsAffected', async () => {
    const stub = new StubDriver();
    stub.userResult = { fields: [], rows: [], rowCount: 3, command: 'INSERT' };
    const { qs, audit } = svc(stub);
    const { response } = await qs.run({ ...base, sql: 'INSERT INTO t VALUES (1)', write: true });
    assert.equal(stub.sqls()[0], 'BEGIN');
    assert.equal(response.rowsAffected, 3);
    assert.equal(audit.entries[0].write, true);
    assert.equal(audit.entries[0].command, 'INSERT');
    assert.equal(audit.entries[0].rowsAffected, 3);
});

test('SET LOCAL guards are present on the write path too', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run({ ...base, sql: 'UPDATE t SET a=1', write: true });
    const sqls = stub.sqls();
    assert.ok(sqls.some((s) => s.startsWith('SET LOCAL statement_timeout')));
    assert.ok(sqls.some((s) => s.startsWith('SET LOCAL idle_in_transaction_session_timeout')));
    assert.ok(sqls.includes('SET LOCAL search_path TO "public", pg_temp'));
});

test('rejects multi-statement SQL before any DB contact', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await assert.rejects(
        () => qs.run({ ...base, sql: 'SELECT 1; DROP TABLE t', write: false }),
        (e) => e instanceof BadRequestError,
    );
    assert.equal(stub.connectCount, 0);
});

test('ROLLBACK + release on query error, error audited', async () => {
    const stub = new StubDriver();
    stub.userError = new Error('boom');
    const { qs, audit } = svc(stub);
    await assert.rejects(() => qs.run({ ...base, sql: 'SELECT bad', write: false }), /boom/);
    assert.ok(stub.sqls().includes('ROLLBACK'));
    assert.equal(stub.released, 1);
    assert.equal(audit.entries[0].error, 'boom');
});

test('destroys the connection (release with error) when ROLLBACK also fails', async () => {
    const stub = new StubDriver();
    stub.userError = new Error('query boom');
    stub.rollbackError = new Error('rollback boom');
    const { qs } = svc(stub);
    await assert.rejects(() => qs.run({ ...base, sql: 'SELECT 1', write: false }), /query boom/);
    assert.equal(stub.released, 1);
    assert.ok(stub.releaseErrors[0]); // released WITH an error → pg destroys the client
});

test('releases the connection clean when ROLLBACK succeeds', async () => {
    const stub = new StubDriver();
    stub.userError = new Error('boom');
    const { qs } = svc(stub);
    await assert.rejects(() => qs.run({ ...base, sql: 'SELECT 1', write: false }), /boom/);
    assert.equal(stub.releaseErrors[0], undefined); // clean release → reused
});

test('clamps timeoutMs down to the datasource statement timeout', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run({ ...base, sql: 'SELECT 1', write: false, timeoutMs: 999999 });
    const setStmt = stub.sqls().find((s) => s.startsWith('SET LOCAL statement_timeout'));
    assert.equal(setStmt, 'SET LOCAL statement_timeout TO 10000');
});

test('truncates to maxRows and sets truncated:true', async () => {
    const stub = new StubDriver();
    stub.userResult = {
        fields: [{ name: 'n', dataType: 'int4' }],
        rows: Array.from({ length: 6 }, (_, i) => ({ n: i })),
        rowCount: 6,
        command: 'SELECT',
    };
    const { qs } = svc(stub);
    const { response } = await qs.run({ ...base, sql: 'SELECT n', write: false, maxRows: 5 });
    assert.equal(response.rows.length, 5);
    assert.equal(response.rowCount, 5);
    assert.equal(response.truncated, true);
});

test('does not truncate when rows <= maxRows', async () => {
    const stub = new StubDriver();
    stub.userResult = { fields: [], rows: [{ a: 1 }, { a: 2 }], rowCount: 2, command: 'SELECT' };
    const { qs } = svc(stub);
    const { response } = await qs.run({ ...base, sql: 'SELECT a', write: false, maxRows: 5 });
    assert.equal(response.truncated, false);
    assert.equal(response.rows.length, 2);
});

test('clamps maxRows to the server ceiling', async () => {
    const stub = new StubDriver();
    stub.userResult = { fields: [], rows: Array.from({ length: 4 }, () => ({})), rowCount: 4, command: 'SELECT' };
    const { qs } = svc(stub, new CapturingAudit(), 3); // ceiling 3
    const { response } = await qs.run({ ...base, sql: 'SELECT n', write: false, maxRows: 1000 });
    assert.equal(response.rows.length, 3);
    assert.equal(response.truncated, true);
});

test('quotes schema identifier, escaping embedded double-quotes', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run({ ...base, schema: 'we"ird', sql: 'SELECT 1', write: false });
    assert.ok(stub.sqls().includes('SET LOCAL search_path TO "we""ird", pg_temp'));
});

test('connect failure → ServiceUnavailableError (503), audited', async () => {
    const stub = new StubDriver();
    stub.connectError = new Error('ECONNREFUSED');
    const { qs, audit } = svc(stub);
    await assert.rejects(
        () => qs.run({ ...base, sql: 'SELECT 1', write: false }),
        (e) => e instanceof ServiceUnavailableError,
    );
    assert.match(audit.entries[0].error ?? '', /unavailable/);
});

test('audits base fields and omits write fields on read path', async () => {
    const stub = new StubDriver();
    const { qs, audit } = svc(stub);
    await qs.run({ tokenId: 'agent_ro', datasource: 'main', schema: 'public', sql: 'SELECT 1', write: false });
    const e = audit.entries[0];
    assert.equal(e.tokenId, 'agent_ro');
    assert.equal(e.datasource, 'main');
    assert.equal(e.schema, 'public');
    assert.equal(e.sql, 'SELECT 1');
    assert.equal(typeof e.elapsedMs, 'number');
    assert.equal(e.write, undefined);
    assert.equal(e.command, undefined);
});

// ── statement guard (Phase 02/03) ──────────────────────────────────────────────

test('guarded datasource: a banned payload is rejected before any DB contact', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await assert.rejects(
        () => qs.run({ ...base, sql: "COPY (SELECT 1) TO PROGRAM 'id'", write: false }),
        (e) => e instanceof BadRequestError,
    );
    assert.equal(stub.connectCount, 0); // never acquired a connection
});

test('guarded datasource: a blocked attempt is audited (security stream must see it)', async () => {
    const stub = new StubDriver();
    const { qs, audit } = svc(stub);
    await assert.rejects(() => qs.run({ ...base, sql: "SELECT pg_read_file('/etc/passwd')", write: false }));
    assert.equal(audit.entries.length, 1);
    assert.equal(audit.entries[0].sql, "SELECT pg_read_file('/etc/passwd')");
    assert.match(audit.entries[0].error ?? '', /not permitted/);
});

test('relaxed datasource (allowUnsafeStatements): the same payload reaches the driver', async () => {
    const stub = new StubDriver();
    const { qs } = unsafeSvc(stub);
    await qs.run({ ...base, sql: "COPY (SELECT 1) TO PROGRAM 'id'", write: false });
    assert.equal(stub.connectCount, 1); // guard skipped → connection acquired
    assert.ok(stub.userStatements().some((s) => s.sql.startsWith('COPY')));
    // Wrap order still holds around the caller SQL even on the relaxed path.
    const sqls = stub.sqls();
    assert.equal(sqls[0], 'BEGIN TRANSACTION READ ONLY');
    assert.ok(sqls.indexOf('COMMIT') > sqls.indexOf("COPY (SELECT 1) TO PROGRAM 'id'"));
    assert.equal(sqls[sqls.length - 1], 'DISCARD ALL');
});

test('multi-statement is rejected even on a relaxed datasource (escape hatch never relaxes that)', async () => {
    const stub = new StubDriver();
    const { qs } = unsafeSvc(stub);
    await assert.rejects(
        () => qs.run({ ...base, sql: 'SELECT 1; DROP TABLE t', write: false }),
        (e) => e instanceof BadRequestError,
    );
    assert.equal(stub.connectCount, 0);
});

// ── relation guard (Phase 03 wiring) ────────────────────────────────────────────

test('relation guard: a catalog read is rejected before any DB contact and is audited', async () => {
    const stub = new StubDriver();
    const { qs, audit } = svc(stub);
    await assert.rejects(
        () => qs.run({ ...base, sql: 'SELECT * FROM information_schema.tables', write: false, allowedSchemas: ['*'] }),
        (e) => e instanceof BadRequestError,
    );
    assert.equal(stub.connectCount, 0); // guard ran pre-connect
    assert.equal(audit.entries.length, 1);
    assert.match(audit.entries[0].error ?? '', /not readable through run_query/);
});

test('relation guard: a cross-schema ref outside caps surfaces ForbiddenError (403 via statusOf)', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await assert.rejects(
        () => qs.run({ ...base, sql: 'SELECT * FROM "tenant_b".t', write: false, allowedSchemas: ['public'] }),
        (e) => e instanceof ForbiddenError && (e as ForbiddenError).status === 403,
    );
    assert.equal(stub.connectCount, 0);
});

test('relation guard: unqualified schema defaults to declared schema only (fail-closed) → cross-schema 403', async () => {
    // No allowedSchemas passed ⇒ defaults to [input.schema] = ['public'].
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await assert.rejects(
        () => qs.run({ ...base, sql: 'SELECT * FROM "tenant_b".t', write: false }),
        (e) => e instanceof ForbiddenError,
    );
    assert.equal(stub.connectCount, 0);
});

test('relation guard: a denied table is rejected before any DB contact and is audited', async () => {
    const stub = new StubDriver();
    const { qs, audit } = deniedSvc(stub);
    await assert.rejects(
        () => qs.run({ ...base, sql: 'SELECT * FROM "user"', write: false, allowedSchemas: ['*'] }),
        (e) => e instanceof BadRequestError,
    );
    assert.equal(stub.connectCount, 0);
    assert.equal(audit.entries.length, 1);
    assert.match(audit.entries[0].error ?? '', /denied-table list/);
});

test('relation guard: an allowed tenant read reaches the driver unchanged', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run({ ...base, sql: 'SELECT id FROM t', write: false, allowedSchemas: ['public'] });
    assert.equal(stub.connectCount, 1);
    assert.ok(stub.userStatements().some((s) => s.sql === 'SELECT id FROM t'));
});

test('relation guard: allowUnsafeStatements skips it — catalog + denied reads reach the driver', async () => {
    for (const sql of ['SELECT * FROM pg_tables', 'SELECT * FROM "user"']) {
        const stub = new StubDriver();
        const { qs } = unsafeSvc(stub);
        await qs.run({ ...base, sql, write: false, allowedSchemas: ['public'] });
        assert.equal(stub.connectCount, 1, sql);
        assert.ok(stub.userStatements().some((s) => s.sql === sql), sql);
    }
});

test('relation guard: the internal trusted path bypasses the catalog block (introspection SQL)', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run(
        { ...base, sql: 'SELECT * FROM information_schema.tables', write: false, allowedSchemas: ['public'] },
        { internalCatalogQuery: true, reason: 'introspection' },
    );
    assert.equal(stub.connectCount, 1); // reached the driver
    assert.ok(stub.userStatements().some((s) => s.sql.includes('information_schema.tables')));
});

// WRITE PATH: the guard must police the write TARGET, not just read-side relations —
// otherwise a write-mode token writes cross-tenant or to a denied table unpoliced.
test('relation guard: a write to a DENIED target is rejected before any DB contact', async () => {
    const stub = new StubDriver();
    const { qs, audit } = deniedSvc(stub); // deniedTables includes 'user'
    await assert.rejects(
        () => qs.run({ ...base, sql: 'DELETE FROM "user" WHERE id = 1', write: true, allowedSchemas: ['*'] }),
        (e) => e instanceof BadRequestError,
    );
    assert.equal(stub.connectCount, 0);
    assert.match(audit.entries[0].error ?? '', /denied-table list/);
});

test('relation guard: a write to a cross-schema target outside caps → 403 before DB contact', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await assert.rejects(
        () => qs.run({ ...base, sql: 'INSERT INTO "tenant_b".t VALUES (1)', write: true, allowedSchemas: ['public'] }),
        (e) => e instanceof ForbiddenError && (e as ForbiddenError).status === 403,
    );
    assert.equal(stub.connectCount, 0);
});
