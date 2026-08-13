/**
 * Real-Postgres integration tests. SKIPPED unless a test DB is configured via
 * PGCP_TEST_* (falls back to the DATABASE_* vars). These validate the
 * behaviors that cannot be proven against a stub:
 *   - P0 tenant isolation: SET LOCAL search_path targets the right schema and
 *     resets on COMMIT (no cross-tenant leak on a reused pooled connection).
 *   - engine-level read-only enforcement (write in a READ ONLY txn is rejected).
 *   - statement_timeout fires; pool ping / drain; write commit + rollback.
 *   - runtime config reload: probe-before-publish, per-datasource degrade, pool
 *     swap and drain (see the reload block at the bottom of this file).
 *
 * Run:  PGCP_TEST_HOST=localhost PGCP_TEST_USER=postgres PGCP_TEST_PASSWORD=postgres \
 *       PGCP_TEST_DATABASE=postgres npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import pino from 'pino';
import { PoolManager } from '../../src/pool/pool-manager.js';
import { PostgresDriver } from '../../src/driver/postgres-driver.js';
import { QueryService } from '../../src/query/query-service.js';
import { IntrospectService } from '../../src/introspect/introspect-service.js';
import type { DatasourceConfig } from '../../src/config/config.schema.js';
import { BadRequestError, ForbiddenError, ServiceUnavailableError } from '../../src/query/gateway-errors.js';
import { buildServices, type Services } from '../../src/services.js';
import { loadConfig } from '../../src/config/load-config.js';
import { reloadConfig } from '../../src/config/reload.js';
import { silentLogger, CapturingAudit } from '../helpers.js';

const HOST = process.env.PGCP_TEST_HOST ?? process.env.DATABASE_HOST;
const RUN = Boolean(HOST);
const opts = { skip: RUN ? false : 'no test Postgres configured (set PGCP_TEST_HOST or DATABASE_HOST)' };

const SCHEMA_A = 'pgcp_test_a';
const SCHEMA_B = 'pgcp_test_b';

/**
 * A second LOGIN role, so the reload "credential change" case swaps to a genuinely
 * different identity rather than re-reading the same one. Created best-effort: a
 * configured cluster where the test user cannot CREATE ROLE still runs the case, with
 * a benign field diff instead (see the swap test — `applyDatasources` takes the
 * identical build→ping→swap→drain path for ANY field difference).
 */
const SWAP_ROLE = 'pgcp_test_swap';
const SWAP_PW = 'pgcp_swap_pw';
let swapRoleReady = false;

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
        // These tests prove real write commit/rollback against the engine, so the
        // datasource-level write gate must be open for them to reach it.
        writable: true,
        // Stated explicitly rather than omitted. Both are inert in THIS stack —
        // allowUnsafeStatements:true skips the relation guard that reads them — but the
        // guarded stack below spreads this object, so they are the values it inherits.
        // Off there for the same reason the shared makeConfig() fixture turns it off:
        // the guarded tests exercise the CONFIG denylist (deniedTables:['secret']) in
        // isolation, and the built-in list has its own opt-in coverage.
        deniedTables: [],
        sensitiveRelationDenylist: false,
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
    // Dedicated write target for the write-gate cases. Deliberately NOT `t`: the tests
    // above assert absolute row counts there, and a case that writes into `t` would
    // couple its result to file ordering.
    await admin.query(`CREATE TABLE ${SCHEMA_A}.w (id int)`);

    // Best-effort: only used by the credential-swap case, and only a superuser-ish
    // test role can create it. A failure here is not a test failure.
    try {
        await admin.query(`DROP ROLE IF EXISTS ${SWAP_ROLE}`);
        await admin.query(`CREATE ROLE ${SWAP_ROLE} LOGIN PASSWORD '${SWAP_PW}'`);
        swapRoleReady = true;
    } catch {
        swapRoleReady = false;
    }
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
    // After every pool is drained, so no session still holds the role open.
    await pools.drainAll();
    await guardedPools.drainAll();
    try {
        await admin.query(`DROP ROLE IF EXISTS ${SWAP_ROLE}`);
    } catch {
        // Best-effort, like its creation — a leftover login role breaks nothing.
    }
    await admin.end();
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

// ── runtime config reload against a live server (multi-datasource-runtime) ───────
//
// The unit suite drives the whole diff state machine against a FAKE pg.Pool, which
// leaves exactly one class of claim unproven: that the probes actually reach a
// database. These cases close that gap — `ping` + the posture probe really run
// against live Postgres before a datasource is published, an unreachable one
// degrades instead of taking the process with it, a pool swap drops no query, and
// `pool.end()` genuinely waits for a checked-out client (risk R5) instead of
// cancelling its query.

/** One captured pino line: the merged fields, plus pino's own `msg`. */
interface LogLine extends Record<string, unknown> {
    msg: string;
}

/** Real pino writing into an array. Level `trace` on purpose: a posture verdict is
 *  `info` when OK and `warn` when WEAK, and both must be observable — filtering to
 *  `warn` would make the OK case look like "no probe ran". */
function capturingLogger(sink: LogLine[]): Services['logger'] {
    return pino(
        { level: 'trace' },
        {
            write: (line: string): void => {
                sink.push(JSON.parse(line) as LogLine);
            },
        },
    );
}

/** Find a log line or fail with a useful message (and narrow the type). */
function logLine(sink: LogLine[], pred: (l: LogLine) => boolean, what: string): LogLine {
    const hit = sink.find(pred);
    if (!hit) throw new Error(`expected a log line: ${what}`);
    return hit;
}

/**
 * Env-file text. EVERY value is quoted: `parseEnvFile` strips one layer of matching
 * outer quotes and keeps the inside verbatim, so a real password containing spaces or
 * a `#` survives the round-trip through disk unchanged. Unquoted it would be trimmed,
 * and the failure would look like "wrong password" with a file that reads correctly.
 */
function envText(map: Record<string, string>): string {
    return Object.entries(map)
        .map(([k, v]) => `${k}="${v}"`)
        .join('\n');
}

/**
 * The `.env` a reload harness boots from AND re-reads on reload.
 *
 * ONE map produces both the boot `RootConfig` and the file on disk, deliberately: any
 * drift between them (LOG_LEVEL was exactly this trap in `test/reload.test.ts`) shows
 * up as a phantom `bootOnlyChanged` entry or a spurious `changed` datasource.
 */
function baseSource(): Record<string, string> {
    const c = dsConfig(2);
    return {
        LOG_LEVEL: 'silent',
        DATASOURCES: 'main',
        DS_MAIN_HOST: c.host,
        DS_MAIN_PORT: String(c.port),
        DS_MAIN_USER: c.user,
        DS_MAIN_PASSWORD: c.password,
        DS_MAIN_DATABASE: c.database,
        DS_MAIN_SSL: String(c.ssl),
        DS_MAIN_DEFAULT_SCHEMA: 'public',
        DS_MAIN_POOL_MAX: '2',
        // Writable STATED, because every config source is now read-only by default —
        // omitting this would leave both datasources read-only and the write-gate case
        // below would be two read-only stacks agreeing with each other instead of a real
        // contrast (same role, same server, opposite verdict). The `datasources.d/` file
        // deliberately omits its `WRITABLE`, so the pair also pins the opt-in asymmetry:
        // written-out `true` writes, omission does not.
        DS_MAIN_WRITABLE: 'true',
        TOKENS: 'agent',
        TOKEN_AGENT_SECRET: 'reload-integration-secret',
        TOKEN_AGENT_DATASOURCES: '*',
        TOKEN_AGENT_MODE: 'write',
        TOKEN_AGENT_SCHEMAS: '*',
    };
}

/** A `datasources.d/<name>.env` body pointing at the SAME live server, in bare-key form.
 *  `WRITABLE` is omitted on purpose — that path is fail-closed, so the datasource lands
 *  read-only and the write gate below has something real to reject. */
function dsFileBody(overrides: Record<string, string> = {}): string {
    const c = dsConfig(2);
    return envText({
        HOST: c.host,
        PORT: String(c.port),
        USER: c.user,
        PASSWORD: c.password,
        DATABASE: c.database,
        SSL: String(c.ssl),
        DEFAULT_SCHEMA: 'public',
        POOL_MAX: '2',
        ...overrides,
    });
}

interface ReloadHarness {
    services: Services;
    source: Record<string, string>;
    envPath: string;
    dsDir: string;
    logs: LogLine[];
    cleanup(): Promise<void>;
}

/** A REAL `Services` (production `buildServices` wiring, real pg pools) plus a temp
 *  `.env` + `datasources.d/` that a reload can actually read. */
function reloadHarness(): ReloadHarness {
    const dir = mkdtempSync(join(tmpdir(), 'pgcp-int-reload-'));
    const dsDir = join(dir, 'datasources.d');
    mkdirSync(dsDir);
    const envPath = join(dir, '.env');
    const source = baseSource();
    writeFileSync(envPath, envText(source));

    const logs: LogLine[] = [];
    const services = buildServices(loadConfig(source), capturingLogger(logs));

    return {
        services,
        source,
        envPath,
        dsDir,
        logs,
        cleanup: async (): Promise<void> => {
            await services.pools.drainAll();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** `baseEnv: {}` so the developer's real environment (and this repo's own `.env`)
 *  cannot leak into the candidate config or the boot-only-key comparison. */
function reloadOpts(h: ReloadHarness): Parameters<typeof reloadConfig>[1] {
    return { envPath: h.envPath, datasourcesDir: h.dsDir, baseEnv: {} };
}

/** Write a datasource file at mode 600 — `writeFileSync` lands 644, which the
 *  permission check (correctly) refuses. */
function writeDsFile(h: ReloadHarness, name: string, body: string): void {
    const p = join(h.dsDir, `${name}.env`);
    writeFileSync(p, body);
    chmodSync(p, 0o600);
}

/** Poll until a condition holds. Used to wait for a query to actually check a client
 *  out of the pool — a fixed sleep would be either flaky or slow. */
async function waitFor(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

test('reload adds a REAL datasource: ping AND the posture probe run against live Postgres before publish', opts, async (t) => {
    const h = reloadHarness();
    t.after(h.cleanup);
    writeDsFile(h, 'warehouse', dsFileBody());

    const report = await reloadConfig(h.services, reloadOpts(h));

    assert.equal(report.ok, true, report.refusedReason);
    assert.deepEqual(report.added, ['warehouse']);
    assert.deepEqual(report.withheld, []);
    assert.ok(h.services.pools.names().includes('warehouse'));

    // The probe REACHED THE CATALOG. `UNVERIFIED` is what a failed probe logs, so a
    // verdict of OK/WEAK is the only outcome that proves live contact — and the fields
    // pin it further: `dbUser` and `writableRelations` can only come from the server.
    // (A fake pool would have produced UNVERIFIED here, which is the point.)
    const posture = logLine(h.logs, (l) => l.datasource === 'warehouse' && /read-only posture/.test(l.msg), 'posture verdict for "warehouse"');
    assert.doesNotMatch(posture.msg, /UNVERIFIED/);
    assert.equal(posture.dbUser, dsConfig(1).user);
    assert.equal(typeof posture.writableRelations, 'number');

    // BEFORE publish. Through `reloadConfig` the staging window is only observable as
    // ordering — the datasource is resolvable-but-unroutable *inside* the probe, and
    // that invariant is pinned directly by the staged-datasource case in
    // test/pool-manager.test.ts. Here we assert the probe preceded the apply summary.
    const appliedIdx = h.logs.findIndex((l) => l.outcome === 'applied');
    assert.ok(appliedIdx >= 0, 'no "applied" reload summary was logged');
    assert.ok(h.logs.indexOf(posture) < appliedIdx, 'posture probe must run before the reload is reported applied');

    // And it genuinely serves: a real row, through the guarded stack, on a datasource
    // that did not exist when this process started.
    const r = await h.services.queryService.run({
        tokenId: 'agent',
        datasource: 'warehouse',
        schema: SCHEMA_A,
        sql: 'SELECT id FROM t',
        write: false,
        allowedSchemas: ['*'],
    });
    assert.deepEqual(r.response.rows, [{ id: 1 }]);
});

test('reload withholds an UNREACHABLE datasource while the gateway keeps serving the healthy one', opts, async (t) => {
    const h = reloadHarness();
    t.after(h.cleanup);
    writeDsFile(h, 'good', dsFileBody());
    // 127.0.0.1:1 rather than a bogus hostname: an unroutable name can hang in DNS or be
    // wildcard-hijacked, while port 1 refuses the connection immediately and locally.
    writeDsFile(
        h,
        'bad',
        envText({ HOST: '127.0.0.1', PORT: '1', USER: 'nobody', PASSWORD: 'nobody', DATABASE: 'nothing', CONNECTION_TIMEOUT_MS: '1000' }),
    );

    const report = await reloadConfig(h.services, reloadOpts(h));

    // Stage 2 degrades per datasource — the reload as a whole still succeeds.
    assert.equal(report.ok, true, report.refusedReason);
    assert.deepEqual(
        report.withheld.map((w) => w.name),
        ['bad'],
    );
    // `bad` sorts first, so it is attempted BEFORE `good`: one failure must not stop the
    // sibling behind it from publishing.
    assert.deepEqual(report.added, ['good']);

    const names = h.services.pools.names();
    assert.ok(!names.includes('bad'), 'a withheld datasource must not be routable');
    assert.ok(names.includes('good'));
    assert.ok(names.includes('main'), 'the pre-existing datasource must survive a partly-failed reload');

    // Still serving — the process did not die and the healthy datasources answer for real.
    for (const datasource of ['main', 'good']) {
        const r = await h.services.queryService.run({
            tokenId: 'agent',
            datasource,
            schema: SCHEMA_A,
            sql: 'SELECT id FROM t',
            write: false,
            allowedSchemas: ['*'],
        });
        assert.deepEqual(r.response.rows, [{ id: 1 }], `datasource ${datasource} stopped serving`);
    }
});

test('a credential change swaps the pool with no failed query during the swap', opts, async (t) => {
    const h = reloadHarness();
    t.after(h.cleanup);

    // A continuous stream of real queries, so the swap happens UNDER LOAD rather than on
    // an idle pool. `SELECT 1` on purpose: it needs nothing but LOGIN + CONNECT, so a
    // post-swap failure can only mean the swap dropped a query — never that the new role
    // lacks a grant on some table.
    let ok = 0;
    const failures: string[] = [];
    let stop = false;
    const loop = (async (): Promise<void> => {
        while (!stop) {
            try {
                await h.services.queryService.run({
                    tokenId: 'agent',
                    datasource: 'main',
                    schema: 'public',
                    sql: 'SELECT 1 AS one',
                    write: false,
                    allowedSchemas: ['*'],
                });
                ok++;
            } catch (err) {
                failures.push((err as Error).message);
            }
        }
    })();

    const beforePool = h.services.pools.getPool('main');
    const next = { ...h.source };
    if (swapRoleReady) {
        // The real case: a different DB identity behind the same logical name.
        next.DS_MAIN_USER = SWAP_ROLE;
        next.DS_MAIN_PASSWORD = SWAP_PW;
    } else {
        // Fallback for a cluster where the test role cannot CREATE ROLE. `applyDatasources`
        // treats ANY field difference as changed and takes the identical
        // build → ping → swap → drain path, so the no-dropped-query property is still
        // fully exercised; only the "different identity" flavour is lost.
        next.DS_MAIN_MAX_USES = '1234';
    }
    writeFileSync(h.envPath, envText(next));

    const report = await reloadConfig(h.services, reloadOpts(h));
    const okAtApply = ok;
    // Keep the load running past the swap: without this tail, "no failures" could describe
    // a window that ended before any query ever reached the NEW pool.
    await new Promise((r) => setTimeout(r, 100));
    stop = true;
    await loop;

    assert.equal(report.ok, true, report.refusedReason);
    assert.deepEqual(report.changed, ['main']);
    assert.deepEqual(report.withheld, []);
    // The pool OBJECT was really replaced — otherwise "no failed query" would be the
    // trivially true statement that nothing happened.
    assert.notEqual(h.services.pools.getPool('main'), beforePool);
    if (swapRoleReady) assert.equal(h.services.pools.getConfig('main').user, SWAP_ROLE);
    // ...and queries were really in flight across it, on both sides. Zero failures over
    // zero queries proves nothing.
    assert.ok(okAtApply > 0, 'no query completed while the reload was in progress');
    assert.ok(ok > okAtApply, 'no query ran against the swapped-in pool');
    assert.deepEqual(failures, [], 'a query failed while the pool was being swapped');

    // The transition was not silent: a credential swap can move a datasource to a role
    // with different write grants, so posture is re-probed on the changed path too. The
    // VERDICT is deliberately unconstrained — per Design Decision 11 the probe runs after
    // the swap and never un-publishes anything.
    logLine(h.logs, (l) => l.datasource === 'main' && /read-only posture/.test(l.msg), 'posture verdict for the swapped datasource');
});

test('SECURITY: a real write against a writable:false datasource is refused by the app layer, though the DB role CAN write', opts, async (t) => {
    const h = reloadHarness();
    t.after(h.cleanup);
    writeDsFile(h, 'warehouse', dsFileBody()); // WRITABLE omitted ⇒ fail-closed

    const report = await reloadConfig(h.services, reloadOpts(h));
    assert.equal(report.ok, true, report.refusedReason);
    assert.equal(h.services.pools.getConfig('warehouse').writable, false);

    // Same server, same role, same table — but through the `.env` datasource, which is
    // writable. This commit is what makes the rejection below attributable to the app
    // gate: the database plainly accepts this write from this identity.
    const w = await h.services.queryService.run({
        tokenId: 'agent',
        datasource: 'main',
        schema: SCHEMA_A,
        sql: 'INSERT INTO w (id) VALUES (4242)',
        write: true,
        allowedSchemas: ['*'],
    });
    assert.equal(w.response.rowsAffected, 1);

    // The identical statement on the read-only datasource: 403 before any DB contact.
    await assert.rejects(
        () =>
            h.services.queryService.run({
                tokenId: 'agent',
                datasource: 'warehouse',
                schema: SCHEMA_A,
                sql: 'INSERT INTO w (id) VALUES (4243)',
                write: true,
                allowedSchemas: ['*'],
            }),
        (e) => e instanceof ForbiddenError,
    );

    // Sentinel-scoped, not a count of the whole table: nothing landed.
    const check = await h.services.queryService.run({
        tokenId: 'agent',
        datasource: 'main',
        schema: SCHEMA_A,
        sql: 'SELECT count(*)::int AS n FROM w WHERE id = 4243',
        write: false,
        allowedSchemas: ['*'],
    });
    assert.equal(check.response.rows[0].n, 0);
});

test('R5: a removed datasource drains WITHOUT cancelling an in-flight query', opts, async (t) => {
    // Driven at the PoolManager seam rather than through reloadConfig: the property under
    // test is `pool.end()`'s behaviour towards a checked-out client, and this keeps the
    // timing assertions free of reload's validation and probe latency.
    const mainCfg = dsConfig(2);
    const doomedCfg: DatasourceConfig = { ...dsConfig(2), name: 'doomed' };
    const localPools = new PoolManager([mainCfg, doomedCfg], silentLogger);
    t.after(() => localPools.drainAll());
    const localQs = new QueryService(new PostgresDriver(localPools), localPools, 10000, new CapturingAudit());

    // `dsConfig` sets allowUnsafeStatements, so pg_sleep reaches the engine. The row value
    // is what we assert on: it can only come back if COMMIT and DISCARD ALL also completed
    // on a client checked out of a pool that has since been end()ed.
    let inflightError: unknown = null;
    const inflight = localQs
        .run({ tokenId: 't', datasource: 'doomed', schema: SCHEMA_A, sql: 'SELECT pg_sleep(2), 7 AS n', write: false })
        .catch((err: unknown) => {
            inflightError = err;
            return null;
        });
    await waitFor(() => localPools.poolSize('doomed') > 0, 'the in-flight query to check a client out');

    const startedAt = Date.now();
    const report = await localPools.applyDatasources([mainCfg]);
    const applyMs = Date.now() - startedAt;

    assert.deepEqual(report.removed, ['doomed']);
    // Unrouted IMMEDIATELY (a new request gets a clean 400 from datasourceReady)...
    assert.ok(!localPools.names().includes('doomed'));
    // ...but still RESOLVABLE, because a request that already passed datasourceReady()
    // reaches getConfig() afterwards and must not turn into a spurious 500. This pair can
    // only both hold inside the drain window, which is itself proof the apply did not wait.
    assert.equal(localPools.getConfig('doomed').name, 'doomed');
    assert.ok(applyMs < 1000, `applyDatasources blocked on the drain (${applyMs}ms of a 2s query)`);

    const r = await inflight;
    if (inflightError) throw inflightError; // the query was cancelled — the R5 regression
    assert.equal(r?.response.rows[0].n, 7);

    // Once the query finishes the drain completes and the entry is dropped for good.
    await waitFor(() => !localPools.names().includes('doomed') && safeGetConfig(localPools, 'doomed') === null, 'the drained datasource to be dropped');
});

/** getConfig() throws for an unknown datasource; this turns that into a testable value. */
function safeGetConfig(p: PoolManager, name: string): DatasourceConfig | null {
    try {
        return p.getConfig(name);
    } catch {
        return null;
    }
}
