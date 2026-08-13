/**
 * reload.e2e.test.ts — the runtime-datasource feature seen from OUTSIDE.
 *
 * `test/reload.test.ts` proves the orchestrator's state machine (what lands in
 * `pools.names()`, what a refusal leaves untouched). This file asks the only question an
 * operator or an agent actually asks: **after the reload, does the request work?** So every
 * assertion here is an HTTP status/body from `app.inject(...)` or an MCP tool result — never
 * `pools.names()`. A test that asserts on the manager is a unit test; the whole promise of
 * this feature lives one layer up, in whether an ALREADY-BUILT app and an ALREADY-REGISTERED
 * tool handler can serve a datasource that did not exist when they were created.
 *
 * That "already built" part is why the app and the MCP session are constructed BEFORE the
 * reload in every case. Building them afterwards would prove nothing: a fresh process can
 * obviously see a datasource in its own boot config.
 *
 * Harness: the `TestPoolManager` + `FakePool` trick from `test/reload.test.ts` (a reload
 * pings every added/changed datasource, and `warehouse.internal` does not resolve) combined
 * with `StubDriver` from `test/helpers.ts` for the query path — so the full
 * auth → route/tool → guard → QueryService path runs with no live Postgres. `Services` is
 * assembled by hand rather than through `buildServices()`, which news up a real `PoolManager`
 * internally and offers no seam for the fake.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Pool as PgPool } from 'pg';
import { PoolManager } from '../src/pool/pool-manager.js';
import { HealthChecker } from '../src/pool/health-checker.js';
import { QueryService } from '../src/query/query-service.js';
import { IntrospectService } from '../src/introspect/introspect-service.js';
import { TokenAuth } from '../src/auth/token-auth.js';
import { AuditLogger } from '../src/audit/audit-logger.js';
import { buildApp } from '../src/build-app.js';
import { registerTools } from '../src/mcp/tools.js';
import { reloadConfig } from '../src/config/reload.js';
import type { Services } from '../src/services.js';
import type { Capabilities } from '../src/auth/token-auth.js';
import type { DatasourceConfig, RootConfig } from '../src/config/config.schema.js';
import { silentLogger, makeConfig, StubDriver } from './helpers.js';

// ── fakes ─────────────────────────────────────────────────────────────────────────

/**
 * A `pg.Pool` stand-in. Reload PINGS every added/changed datasource through the real
 * `PoolManager.pingPool()` before publishing it, so without this a case that adds
 * `warehouse.internal` would do a real DNS lookup and be withheld.
 *
 * `totalCount` is not decoration: `GET /health` reports `pools.poolSize(name)`, which reads
 * it straight off the pool object, and the regression battery below asserts on that body.
 */
class FakePool {
    totalCount = 0;
    on(): this {
        return this;
    }
    async end(): Promise<void> {
        return undefined;
    }
    async connect(): Promise<{ query: () => Promise<unknown>; release: () => void }> {
        return { query: async () => ({ rows: [] }), release: () => undefined };
    }
}

class TestPoolManager extends PoolManager {
    protected override newPool(): PgPool {
        return new FakePool() as unknown as PgPool;
    }
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Minimal McpServer stand-in that captures tool registrations (mirrors test/mcp-tools.test.ts). */
class FakeMcp {
    tools = new Map<string, { config: Record<string, unknown>; handler: Handler }>();
    registerTool(name: string, config: Record<string, unknown>, handler: Handler): unknown {
        this.tools.set(name, { config, handler });
        return {};
    }
}

// ── fixtures ──────────────────────────────────────────────────────────────────────

/**
 * Boot config = the shared `makeConfig()` fixture plus a third token.
 *
 * `scoped` exists in every case so the explicit-grant control is a real token from boot
 * rather than something conjured by the reload under test — it must be a token that WAS
 * there and still does not reach the new datasource.
 */
function bootConfig(over: Partial<RootConfig> = {}): RootConfig {
    return makeConfig({
        tokens: [
            { id: 'agent_ro', secret: 'ro-secret', datasources: ['main'], mode: 'read', schemas: ['*'] },
            { id: 'svc_rw', secret: 'rw-secret', datasources: ['main'], mode: 'write', schemas: ['public'] },
            { id: 'scoped', secret: 'scoped-secret', datasources: ['main'], mode: 'read', schemas: ['*'] },
        ],
        ...over,
    });
}

interface Harness {
    services: Services;
    app: FastifyInstance;
    stub: StubDriver;
    dir: string;
    envPath: string;
    dsDir: string;
    cleanup(): Promise<void>;
}

async function harness(config: RootConfig = bootConfig()): Promise<Harness> {
    const dir = mkdtempSync(join(tmpdir(), 'pgcp-reload-e2e-'));
    const dsDir = join(dir, 'datasources.d');
    mkdirSync(dsDir);

    const pools = new TestPoolManager(config.datasources, silentLogger);
    const driver = new StubDriver();
    const audit = new AuditLogger(silentLogger);
    const queryService = new QueryService(driver, pools, config.maxRowsCeiling, audit);

    const services: Services = {
        config,
        logger: silentLogger,
        pools,
        driver,
        // ttl 0 — never serve a cached verdict, so a /health body compared before and after
        // a reload reflects the pools as they are, not a window that happened to still be open.
        health: new HealthChecker(driver, 0),
        queryService,
        introspectService: new IntrospectService(queryService, pools),
        auth: new TokenAuth(config.tokens),
        audit,
    };

    // Built BEFORE any reload — the point of every case in this file.
    const app = buildApp(services);
    await app.ready();

    return {
        services,
        app,
        stub: driver,
        dir,
        envPath: join(dir, '.env'),
        dsDir,
        cleanup: async (): Promise<void> => {
            await app.close();
            await pools.drainAll();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

/**
 * Write a `.env` that reproduces `bootConfig()` EXACTLY, plus whatever `extra` says
 * (later keys win, so `extra` can override any line above).
 *
 * Exact matters: `applyDatasources` reports ANY field difference as `changed`, so a single
 * drifting default would make `main` churn its pool on every reload and quietly falsify the
 * "nothing changed" regression assertions. Two lines here are not defaults and are the ones
 * that will bite whoever edits this next:
 *
 *   DS_MAIN_SENSITIVE_RELATION_DENYLIST=false — the zod default is `true`, but the shared
 *     `makeConfig()` fixture turns it off.
 *   DS_MAIN_WRITABLE=true — `writable` now defaults to FALSE from every config source
 *     (`.env`, `datasources.d/` and the `DATABASE_*` fallback alike), while `makeConfig()`
 *     boots `main` writable. Omitting it silently flips `main` read-only on the first
 *     reload, which reads as a mysterious 403 several assertions later.
 *
 * Everything else in `makeConfig()`'s datasource is already the schema default.
 */
function writeEnv(h: Harness, extra = ''): void {
    writeFileSync(
        h.envPath,
        [
            'LOG_LEVEL=silent',
            'DATASOURCES=main',
            'DS_MAIN_HOST=localhost',
            'DS_MAIN_USER=postgres',
            'DS_MAIN_PASSWORD=postgres',
            'DS_MAIN_DATABASE=appdb',
            'DS_MAIN_SENSITIVE_RELATION_DENYLIST=false',
            'DS_MAIN_WRITABLE=true',
            'TOKENS=agent_ro,svc_rw,scoped',
            'TOKEN_AGENT_RO_SECRET=ro-secret',
            'TOKEN_AGENT_RO_DATASOURCES=main',
            'TOKEN_AGENT_RO_MODE=read',
            'TOKEN_AGENT_RO_SCHEMAS=*',
            'TOKEN_SVC_RW_SECRET=rw-secret',
            'TOKEN_SVC_RW_DATASOURCES=main',
            'TOKEN_SVC_RW_MODE=write',
            'TOKEN_SVC_RW_SCHEMAS=public',
            'TOKEN_SCOPED_SECRET=scoped-secret',
            'TOKEN_SCOPED_DATASOURCES=main',
            'TOKEN_SCOPED_MODE=read',
            'TOKEN_SCOPED_SCHEMAS=*',
            extra,
        ].join('\n'),
    );
}

/** The operator's hand-authored credential file. Bare keys + mode 600, as the reader demands. */
const WAREHOUSE = ['HOST=warehouse.internal', 'USER=agent_ro', 'PASSWORD=s3cret-warehouse-pw', 'DATABASE=analytics', 'DEFAULT_SCHEMA=analytics'].join('\n');

function writeDsFile(h: Harness, name: string, body: string): void {
    const p = join(h.dsDir, `${name}.env`);
    writeFileSync(p, body);
    chmodSync(p, 0o600);
}

/** Empty `baseEnv` so the developer's real environment cannot leak into a candidate config. */
function opts(h: Harness, extra: Record<string, unknown> = {}): Parameters<typeof reloadConfig>[1] {
    return { envPath: h.envPath, datasourcesDir: h.dsDir, baseEnv: {}, ...extra } as Parameters<typeof reloadConfig>[1];
}

// ── request helpers ───────────────────────────────────────────────────────────────

const bearer = (secret: string): Record<string, string> => ({ authorization: `Bearer ${secret}` });

/** One row of stub output, so a 200 is distinguishable from an empty success. */
function seedRow(h: Harness): void {
    h.stub.calls = [];
    h.stub.userResult = { fields: [{ name: 'id', dataType: 'uuid' }], rows: [{ id: 'a' }], rowCount: 1, command: 'SELECT' };
}

function query(h: Harness, secret: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
    return h.app.inject({ method: 'POST', url: '/query', headers: bearer(secret), payload });
}

interface McpSession {
    fake: FakeMcp;
    caps: Capabilities;
    call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
    json(tool: string, args?: Record<string, unknown>): Promise<any>;
}

/**
 * Register the five tools under the caps a real bearer token resolves to — the same object
 * production hands `registerTools()` (`mcp/mcp-server.ts:37,60`), and therefore the same one
 * a reload's `liveCaps` refresh has to patch in place.
 */
function mcpSession(h: Harness, secret: string): McpSession {
    const caps = h.services.auth.authenticate(`Bearer ${secret}`);
    assert.ok(caps, `token "${secret}" did not authenticate`);
    const fake = new FakeMcp();
    registerTools(fake as never, h.services, caps);
    const call = (tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> => fake.tools.get(tool)!.handler(args);
    return {
        fake,
        caps,
        call,
        json: async (tool: string, args: Record<string, unknown> = {}): Promise<any> => {
            const res = await call(tool, args);
            assert.notEqual(res.isError, true, res.content[0]?.text);
            return JSON.parse(res.content[0].text);
        },
    };
}

// =================================================================================
// The four flows
// =================================================================================

test('E2E operator flow: datasources.d file + reload makes POST /query on the NEW datasource succeed', async (t) => {
    const h = await harness();
    t.after(h.cleanup);

    // Before: the token has no grant for `warehouse`, so membership fails BEFORE existence —
    // 403, not 400. That ordering is deliberate (route-helpers.datasourceReady) and is what
    // stops a caller enumerating datasources it cannot reach.
    const before = await query(h, 'ro-secret', { datasource: 'warehouse', sql: 'SELECT id FROM orders' });
    assert.equal(before.statusCode, 403);

    // The operator's two edits: one credential file, one grant.
    writeEnv(h, 'TOKEN_AGENT_RO_DATASOURCES=main,warehouse');
    writeDsFile(h, 'warehouse', WAREHOUSE);

    const report = await reloadConfig(h.services, opts(h));
    assert.equal(report.ok, true, report.refusedReason);
    assert.deepEqual(report.added, ['warehouse']);
    assert.deepEqual(report.changed, [], 'the untouched .env datasource must not churn its pool');

    // The payoff: the SAME Fastify instance, built before the file existed, now serves it.
    seedRow(h);
    const after = await query(h, 'ro-secret', { datasource: 'warehouse', sql: 'SELECT id FROM orders' });
    assert.equal(after.statusCode, 200, after.body);
    assert.equal(after.json().rowCount, 1);
    assert.deepEqual(after.json().columns, [{ name: 'id', dataType: 'uuid' }]);
    // It really ran the guarded read path against the new datasource, not a cached anything.
    assert.ok(h.stub.sqls().includes('BEGIN TRANSACTION READ ONLY'));
    assert.ok(h.stub.sqls().includes('SET LOCAL search_path TO "analytics", pg_temp'));

    // …and the listing the operator would check reflects it, fail-closed default included.
    const listed = await h.app.inject({ method: 'GET', url: '/datasources', headers: bearer('ro-secret') });
    assert.deepEqual(listed.json(), [
        { name: 'main', defaultSchema: 'public', writable: true },
        { name: 'warehouse', defaultSchema: 'analytics', writable: false },
    ]);
});

test('E2E agent flow: list_datasources → run_query on the discovered name, in one already-registered session', async (t) => {
    const h = await harness();
    t.after(h.cleanup);

    // The session is registered NOW, holding the caps object resolved from `ro-secret` at
    // this instant. Everything below happens without re-registering a single tool.
    const mcp = mcpSession(h, 'ro-secret');
    assert.deepEqual((await mcp.json('list_datasources')).datasources, [{ name: 'main', defaultSchema: 'public', writable: true }]);

    writeEnv(h, 'TOKEN_AGENT_RO_DATASOURCES=main,warehouse');
    writeDsFile(h, 'warehouse', WAREHOUSE);

    // `liveCaps` is what production passes (mcp/mcp-server.ts:60): `applyTokens` splices in
    // BRAND-NEW caps objects, so the one this handler closed over is stale the instant the
    // reload lands and only an in-place `Object.assign` reaches it. The HTTP path never needs
    // this — it re-authenticates per request — which is precisely why the mechanism exists
    // for stdio MCP alone, and why this is the case worth guarding hardest.
    const report = await reloadConfig(h.services, opts(h, { liveCaps: mcp.caps, mcpToken: 'ro-secret', identity: 'agent_ro' }));
    assert.equal(report.ok, true, report.refusedReason);

    // DISCOVER…
    const listed: { name: string; defaultSchema: string; writable: boolean }[] = (await mcp.json('list_datasources')).datasources;
    const discovered = listed.find((d) => d.name !== 'main');
    assert.ok(discovered, 'the agent must be able to discover the new datasource mid-session');
    assert.deepEqual(discovered, { name: 'warehouse', defaultSchema: 'analytics', writable: false });

    // …then USE, feeding the name straight back in. Nothing in this test types "warehouse"
    // into run_query: the value comes from the tool output, which is the actual agent loop.
    seedRow(h);
    const ran = await mcp.json('run_query', { datasource: discovered.name, sql: 'SELECT id FROM orders' });
    assert.equal(ran.rowCount, 1);
    assert.equal(ran.truncated, false);
    assert.ok(h.stub.sqls().includes('BEGIN TRANSACTION READ ONLY'));
});

test('the agent flow depends on the liveCaps refresh — without it the registered handler stays blind to the new grant', async (t) => {
    const h = await harness();
    t.after(h.cleanup);
    const mcp = mcpSession(h, 'ro-secret');

    writeEnv(h, 'TOKEN_AGENT_RO_DATASOURCES=main,warehouse');
    writeDsFile(h, 'warehouse', WAREHOUSE);

    // Identical reload, `liveCaps` omitted. This is the negative control that keeps the
    // previous test honest: if `Object.assign(liveCaps, capsById(id))` were deleted from
    // reload.ts, THIS test would still pass and the agent-flow test would fail — the pair
    // localises the break to the refresh rather than to the reload.
    const report = await reloadConfig(h.services, opts(h, { mcpToken: 'ro-secret', identity: 'agent_ro' }));
    assert.equal(report.ok, true, report.refusedReason);
    assert.deepEqual(report.added, ['warehouse'], 'the datasource IS published — only the handler caps are stale');

    // Stale caps still say ['main'], and the filter is applied at call time, so the handler
    // fails CLOSED: it neither lists nor reaches a datasource its captured grant lacks.
    assert.deepEqual((await mcp.json('list_datasources')).datasources, [{ name: 'main', defaultSchema: 'public', writable: true }]);
    const denied = await mcp.call('run_query', { datasource: 'warehouse', sql: 'SELECT id FROM orders' });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /not permitted/);
});

test('E2E wildcard-token flow: DATASOURCES=* makes a new datasource usable with NO .env edit', async (t) => {
    const h = await harness(bootConfig({
        tokens: [{ id: 'agent_ro', secret: 'ro-secret', datasources: ['*'], mode: 'read', schemas: ['*'] }],
    }));
    t.after(h.cleanup);

    // A wildcard grant needs no caps refresh at all — `capabilityAllows(['*'], …)` is true
    // whatever the caps object holds — so this session is deliberately registered up front and
    // NEVER refreshed. That contrast is the point: explicit grants need the liveCaps
    // mechanism, `'*'` does not.
    const mcp = mcpSession(h, 'ro-secret');

    writeEnv(h, ['TOKENS=agent_ro', 'TOKEN_AGENT_RO_DATASOURCES=*'].join('\n'));
    const seeded = await reloadConfig(h.services, opts(h));
    assert.equal(seeded.ok, true, seeded.refusedReason);

    // Wildcard permits it; it simply is not there yet → 400 unknown, NOT 403.
    const before = await query(h, 'ro-secret', { datasource: 'warehouse', sql: 'SELECT id FROM orders' });
    assert.equal(before.statusCode, 400);
    assert.match(before.json().error, /unknown datasource/);

    // The operator drops in ONE file and touches nothing else.
    const envBytes = readFileSync(h.envPath);
    writeDsFile(h, 'warehouse', WAREHOUSE);
    const report = await reloadConfig(h.services, opts(h));

    assert.equal(report.ok, true, report.refusedReason);
    assert.deepEqual(report.added, ['warehouse']);
    assert.deepEqual(readFileSync(h.envPath), envBytes, '.env must not have been edited for this flow');

    seedRow(h);
    const after = await query(h, 'ro-secret', { datasource: 'warehouse', sql: 'SELECT id FROM orders' });
    assert.equal(after.statusCode, 200, after.body);
    assert.equal(after.json().rowCount, 1);

    // Same story on the un-refreshed MCP session.
    const listed: { name: string }[] = (await mcp.json('list_datasources')).datasources;
    assert.deepEqual(listed.map((d) => d.name), ['main', 'warehouse']);
    seedRow(h);
    assert.equal((await mcp.json('run_query', { datasource: 'warehouse', sql: 'SELECT id FROM orders' })).rowCount, 1);
});

test('SECURITY: E2E explicit-grant flow — a token not granted the new datasource gets 403 and cannot even see it', async (t) => {
    const h = await harness();
    t.after(h.cleanup);
    const scopedMcp = mcpSession(h, 'scoped-secret');

    // agent_ro gains `warehouse`; `scoped` is left on `main` alone.
    writeEnv(h, 'TOKEN_AGENT_RO_DATASOURCES=main,warehouse');
    writeDsFile(h, 'warehouse', WAREHOUSE);
    // `mcpToken` matters here, not just `liveCaps`: the refresh resolves the identity by
    // SECRET, so without it the reload takes the "not refreshed" branch and the caps
    // assertion below would pass against an object nothing had touched — a vacuous control
    // for the very thing it is meant to rule out.
    const report = await reloadConfig(h.services, opts(h, { liveCaps: scopedMcp.caps, mcpToken: 'scoped-secret', identity: 'scoped' }));
    assert.equal(report.ok, true, report.refusedReason);

    // Positive control FIRST: the datasource genuinely works, so the 403 below is about the
    // grant and not about a warehouse that is simply broken.
    seedRow(h);
    assert.equal((await query(h, 'ro-secret', { datasource: 'warehouse', sql: 'SELECT id FROM orders' })).statusCode, 200);

    const denied = await query(h, 'scoped-secret', { datasource: 'warehouse', sql: 'SELECT id FROM orders' });
    assert.equal(denied.statusCode, 403);
    assert.match(denied.json().error, /datasource "warehouse" not permitted/);

    // A reload widens what EXISTS, never what a token may reach: the listing must stay
    // filtered, and the ungranted name must not appear even as a substring an LLM could read.
    const listed = await h.app.inject({ method: 'GET', url: '/datasources', headers: bearer('scoped-secret') });
    assert.deepEqual(listed.json(), [{ name: 'main', defaultSchema: 'public', writable: true }]);

    // The MCP twin — same identity, same verdict. `liveCaps` WAS genuinely refreshed above
    // (by secret), so this cannot pass merely because the handler held a stale, narrower
    // capability set that never saw the reload.
    assert.deepEqual(scopedMcp.caps.datasources, ['main']);
    const mcpListed = await scopedMcp.call('list_datasources');
    assert.equal(mcpListed.content[0].text.includes('warehouse'), false);
    // Zeroed HERE, not at the top: the positive control above and the reload's own posture
    // probe both connect legitimately, so a counter read from the start of the test would
    // measure them rather than this call.
    h.stub.connectCount = 0;
    const mcpDenied = await scopedMcp.call('run_query', { datasource: 'warehouse', sql: 'SELECT id FROM orders' });
    assert.equal(mcpDenied.isError, true);
    assert.match(mcpDenied.content[0].text, /datasource "warehouse" not permitted/);
    // Denied before any DB contact, like every other caps rejection.
    assert.equal(h.stub.connectCount, 0);
});

// =================================================================================
// Regressions — the feature must be invisible to a deployment that does not use it
// =================================================================================

/**
 * Snapshot of every route and tool behaviour that predates this feature, as JSON.
 *
 * `elapsedMs` is stripped: it is `Date.now()`-derived, so a naive deep-equal of two /query
 * bodies would fail for a reason that has nothing to do with the reload.
 */
async function battery(h: Harness, mcp: McpSession): Promise<unknown> {
    const strip = (body: Record<string, unknown>): Record<string, unknown> => {
        const { elapsedMs: _elapsed, ...rest } = body;
        return rest;
    };

    seedRow(h);
    const read = await query(h, 'ro-secret', { datasource: 'main', sql: 'SELECT id FROM orders' });
    const writeDenied = await query(h, 'ro-secret', { datasource: 'main', sql: 'INSERT INTO orders VALUES (1)', readOnly: false });

    h.stub.userResult = { fields: [], rows: [], rowCount: 1, command: 'INSERT' };
    const writeOk = await query(h, 'rw-secret', { datasource: 'main', schema: 'public', sql: 'INSERT INTO orders VALUES (1)', readOnly: false });

    const catalog = await query(h, 'ro-secret', { datasource: 'main', sql: 'SELECT * FROM information_schema.tables' });
    const unknown = await query(h, 'ro-secret', { datasource: 'ghost', sql: 'SELECT 1' });
    const unauthed = await h.app.inject({ method: 'POST', url: '/query', payload: { datasource: 'main', sql: 'SELECT 1' } });

    const health = await h.app.inject({ method: 'GET', url: '/health' });
    const datasources = await h.app.inject({ method: 'GET', url: '/datasources', headers: bearer('ro-secret') });

    h.stub.userResult = { fields: [], rows: [{ table_name: 't1', table_type: 'BASE TABLE' }], rowCount: 1, command: 'SELECT' };
    const tables = await h.app.inject({ method: 'POST', url: '/introspect/tables', headers: bearer('ro-secret'), payload: { datasource: 'main', schema: 'public' } });

    seedRow(h);
    const mcpRun = await mcp.call('run_query', { datasource: 'main', sql: 'SELECT id FROM orders' });
    const mcpList = await mcp.call('list_datasources');

    return {
        read: [read.statusCode, strip(read.json())],
        writeDenied: [writeDenied.statusCode, writeDenied.json()],
        writeOk: [writeOk.statusCode, strip(writeOk.json())],
        catalog: [catalog.statusCode, catalog.json()],
        unknown: [unknown.statusCode, unknown.json()],
        unauthed: [unauthed.statusCode, unauthed.json()],
        health: [health.statusCode, health.json()],
        datasources: [datasources.statusCode, datasources.json()],
        tables: [tables.statusCode, tables.json()],
        mcpRun: [mcpRun.isError, strip(JSON.parse(mcpRun.content[0].text))],
        mcpList: [mcpList.isError, JSON.parse(mcpList.content[0].text)],
    };
}

test('E2E regression: every route and tool behaves identically when no datasources.d/ exists', async (t) => {
    const h = await harness();
    t.after(h.cleanup);
    const mcp = mcpSession(h, 'ro-secret');
    writeEnv(h); // a pre-feature deployment: .env only

    const before = await battery(h, mcp);

    // The directory is not merely empty — it does not exist, which is the state every
    // deployment that predates this feature is in. `readDatasourcesDir` must treat ENOENT as
    // "no datasources here", not as a failure, or a SIGHUP would refuse on every such box.
    const report = await reloadConfig(h.services, opts(h, { datasourcesDir: join(h.dir, 'no-such-dir') }));

    assert.equal(report.ok, true, report.refusedReason);
    assert.deepEqual([report.added, report.changed, report.removed, report.withheld, report.bootOnlyChanged], [[], [], [], [], []]);
    assert.deepEqual(await battery(h, mcp), before);
});

test('SECURITY: E2E write behaviour — an explicitly writable .env datasource still writes; every silent datasource is 403, whatever source defined it', async (t) => {
    const h = await harness();
    t.after(h.cleanup);

    // Three datasources, ONE write token that reaches all three with schemas '*'. Both token
    // gates (write mode + explicit readOnly:false) are therefore satisfied every time, so the
    // only thing separating the outcomes is each datasource's own `writable` flag — which is
    // exactly the third gate this asserts, at the transport rather than the service layer.
    //
    // NOTE ON THE CONTRACT. `writable` now defaults to FALSE from every source, `.env`
    // included; the earlier "`.env` stays writable for backward compatibility" asymmetry was
    // removed deliberately (see load-config.ts `buildDatasource`). So "today's write
    // behaviour" is asserted as the two separable halves it has become: the write PATH is
    // unregressed for a datasource that opts in, and everything that stays silent — no
    // matter which file it came from — is refused.
    writeEnv(
        h,
        [
            'DATASOURCES=main,legacy',
            // `legacy` is .env-defined and says NOTHING about writes — the case that used to
            // be writable by omission.
            'DS_LEGACY_HOST=legacy.internal',
            'DS_LEGACY_USER=postgres',
            'DS_LEGACY_DATABASE=legacydb',
            'TOKEN_SVC_RW_DATASOURCES=main,legacy,warehouse',
            'TOKEN_SVC_RW_SCHEMAS=*',
        ].join('\n'),
    );
    writeDsFile(h, 'warehouse', WAREHOUSE);
    const report = await reloadConfig(h.services, opts(h));
    assert.equal(report.ok, true, report.refusedReason);
    assert.deepEqual(report.added.sort(), ['legacy', 'warehouse']);

    // Opted in with DS_MAIN_WRITABLE=true → the write path is exactly what it always was.
    h.stub.calls = [];
    h.stub.userResult = { fields: [], rows: [], rowCount: 1, command: 'INSERT' };
    const toMain = await query(h, 'rw-secret', { datasource: 'main', schema: 'public', sql: 'INSERT INTO orders VALUES (1)', readOnly: false });
    assert.equal(toMain.statusCode, 200, toMain.body);
    assert.equal(toMain.json().rowsAffected, 1);
    assert.equal(h.stub.sqls()[0], 'BEGIN', 'a write txn, not a read-only one');

    // Silent datasources — one from `.env`, one from `datasources.d/` — are both refused, and
    // refused identically. The write dies at the QueryService gate before any DB contact,
    // even though the very same token just wrote to `main` a moment ago.
    for (const datasource of ['legacy', 'warehouse']) {
        h.stub.calls = [];
        h.stub.connectCount = 0;
        const denied = await query(h, 'rw-secret', { datasource, sql: 'INSERT INTO orders VALUES (1)', readOnly: false });
        assert.equal(denied.statusCode, 403, `${datasource}: ${denied.body}`);
        assert.match(denied.json().error, /not writable/);
        assert.equal(h.stub.connectCount, 0, `${datasource} was contacted`);
        assert.deepEqual(h.stub.sqls(), [], `${datasource}: not even a BEGIN may reach a read-only datasource`);
    }

    // …and the listing says so up front, so a caller never has to discover it by failing.
    const listed = await h.app.inject({ method: 'GET', url: '/datasources', headers: bearer('rw-secret') });
    assert.deepEqual(listed.json(), [
        { name: 'main', defaultSchema: 'public', writable: true },
        { name: 'legacy', defaultSchema: 'public', writable: false },
        { name: 'warehouse', defaultSchema: 'analytics', writable: false },
    ]);
});
