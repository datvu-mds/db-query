/**
 * config/reload.ts — the two-stage failure model.
 *
 * Stage 1 is ALL-OR-NOTHING: any validation failure must leave the running config
 * bit-for-bit unchanged. Stage 2 DEGRADES PER DATASOURCE: the server never dies, and
 * one bad datasource must not take a sibling down with it.
 *
 * The single most important assertion class here is the stage-1 one: after a refusal,
 * `pools.names()` and the token digests must be identical to before. A reload that
 * half-applies is worse than one that refuses, because the operator has no way to know
 * which half landed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool as PgPool } from 'pg';
import { PoolManager } from '../src/pool/pool-manager.js';
import { HealthChecker } from '../src/pool/health-checker.js';
import { QueryService } from '../src/query/query-service.js';
import { IntrospectService } from '../src/introspect/introspect-service.js';
import { TokenAuth } from '../src/auth/token-auth.js';
import { AuditLogger } from '../src/audit/audit-logger.js';
import { reloadConfig, createReloadRunner } from '../src/config/reload.js';
import type { Services } from '../src/services.js';
import type { DatasourceConfig, RootConfig } from '../src/config/config.schema.js';
import { makeConfig, StubDriver } from './helpers.js';

// --- a PoolManager whose pg.Pool is fake, so ping()/end() need no live Postgres ----

class FakePool {
    ended = false;
    connectError: Error | null = null;
    on(): this {
        return this;
    }
    async end(): Promise<void> {
        this.ended = true;
    }
    async connect(): Promise<{ query: () => Promise<unknown>; release: () => void }> {
        if (this.connectError) throw this.connectError;
        return { query: async () => ({ rows: [] }), release: () => undefined };
    }
}

/** Hosts listed here produce a pool whose connect() fails — i.e. an unreachable datasource. */
let unreachableHosts = new Set<string>();

class TestPoolManager extends PoolManager {
    protected override newPool(ds: DatasourceConfig): PgPool {
        const pool = new FakePool();
        if (unreachableHosts.has(ds.host)) pool.connectError = new Error(`getaddrinfo ENOTFOUND ${ds.host}`);
        return pool as unknown as PgPool;
    }
}

// --- fixtures --------------------------------------------------------------------

interface Harness {
    services: Services;
    dir: string;
    envPath: string;
    dsDir: string;
    logs: { level: string; msg: string; fields: Record<string, unknown> }[];
    cleanup(): void;
}

/** Capture log lines so we can assert what a reload reports — and what it never reports. */
function capturingLogger(sink: Harness['logs']): Services['logger'] {
    const rec =
        (level: string) =>
        (a: unknown, b?: unknown): void => {
            const fields = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>;
            sink.push({ level, msg: String(typeof a === 'string' ? a : (b ?? '')), fields });
        };
    const log = {
        info: rec('info'),
        warn: rec('warn'),
        error: rec('error'),
        fatal: rec('fatal'),
        debug: rec('debug'),
        trace: rec('trace'),
        silent: rec('silent'),
        level: 'info',
        // AuditLogger builds a child logger; keep it recording into the SAME sink so the
        // "no credential values in any log line" assertion covers audit output too.
        child: () => log,
    };
    return log as unknown as Services['logger'];
}

function harness(bootConfig: RootConfig = makeConfig()): Harness {
    unreachableHosts = new Set();
    const dir = mkdtempSync(join(tmpdir(), 'pgcp-reload-'));
    const dsDir = join(dir, 'datasources.d');
    mkdirSync(dsDir);
    const envPath = join(dir, '.env');

    const logs: Harness['logs'] = [];
    const logger = capturingLogger(logs);
    const pools = new TestPoolManager(bootConfig.datasources, logger);
    const driver = new StubDriver();
    const audit = new AuditLogger(logger);
    const queryService = new QueryService(driver, pools, bootConfig.maxRowsCeiling, audit);

    const services: Services = {
        config: bootConfig,
        logger,
        pools,
        driver,
        health: new HealthChecker(driver, 5000),
        queryService,
        introspectService: new IntrospectService(queryService, pools),
        auth: new TokenAuth(bootConfig.tokens),
        audit,
    };

    return { services, dir, envPath, dsDir, logs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write a `.env` that reproduces the boot config, plus whatever `extra` says. */
function writeEnv(h: Harness, extra = ''): void {
    writeFileSync(
        h.envPath,
        [
            // Reproduce the BOOT config faithfully, so anything a test does not
            // deliberately change compares equal — otherwise every boot-only-key
            // assertion picks up incidental drift (logLevel was exactly that).
            'LOG_LEVEL=silent',
            'DATASOURCES=main',
            'DS_MAIN_HOST=localhost',
            'DS_MAIN_USER=postgres',
            'DS_MAIN_PASSWORD=postgres',
            'DS_MAIN_DATABASE=appdb',
            // makeConfig()'s fixture turns this OFF; the zod default is ON. Without it the
            // reloaded `main` differs from the booted one on every single reload, so `main`
            // would be permanently "changed" — re-pinged, re-probed and re-pooled by a
            // no-op SIGHUP, and the untouched-datasource assertions would pass vacuously.
            'DS_MAIN_SENSITIVE_RELATION_DENYLIST=false',
            // Likewise: makeConfig()'s fixture is writable, but WRITABLE now defaults
            // FALSE from every source, so without this `main` compares as changed on
            // every reload. (This assertion is exactly what caught the default flip.)
            'DS_MAIN_WRITABLE=true',
            'TOKENS=agent_ro,svc_rw',
            'TOKEN_AGENT_RO_SECRET=ro-secret',
            'TOKEN_AGENT_RO_DATASOURCES=main',
            'TOKEN_AGENT_RO_MODE=read',
            'TOKEN_AGENT_RO_SCHEMAS=*',
            'TOKEN_SVC_RW_SECRET=rw-secret',
            'TOKEN_SVC_RW_DATASOURCES=main',
            'TOKEN_SVC_RW_MODE=write',
            'TOKEN_SVC_RW_SCHEMAS=public',
            extra,
        ].join('\n'),
    );
}

function writeDsFile(h: Harness, name: string, body: string, mode = 0o600): string {
    const p = join(h.dsDir, `${name}.env`);
    writeFileSync(p, body);
    chmodSync(p, mode);
    return p;
}

const WAREHOUSE = ['HOST=warehouse.internal', 'USER=agent_ro', 'PASSWORD=s3cret-warehouse-pw', 'DATABASE=analytics'].join('\n');

/** An empty base env, so tests are not affected by the developer's real environment. */
function opts(h: Harness, extra: Record<string, unknown> = {}): Parameters<typeof reloadConfig>[1] {
    return { envPath: h.envPath, datasourcesDir: h.dsDir, baseEnv: {}, ...extra } as Parameters<typeof reloadConfig>[1];
}

/** Digest fingerprint — proves the token state is byte-identical across a refusal.
 *  Probes with the REAL configured secrets plus one that must never authenticate. */
function tokenFingerprint(services: Services): string {
    return JSON.stringify(['ro-secret', 'rw-secret', 'nope-secret'].map((s) => services.auth.authenticate(`Bearer ${s}`)?.id ?? null));
}

const INTACT = JSON.stringify(['agent_ro', 'svc_rw', null]);

// =================================================================================
// Stage 1 — validation is ALL-OR-NOTHING
// =================================================================================

test('a valid reload publishes added datasources and reports added/changed/removed', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    writeDsFile(h, 'warehouse', WAREHOUSE);

    const report = await reloadConfig(h.services, opts(h));

    assert.equal(report.ok, true, report.refusedReason);
    assert.deepEqual(report.added, ['warehouse']);
    assert.deepEqual(report.removed, []);
    // A no-op SIGHUP must not churn an untouched datasource: if `main` round-trips
    // through the loader identically, it is neither re-pinged, re-probed, nor re-pooled.
    assert.deepEqual(report.changed, [], 'an untouched datasource must not be reported changed');
    assert.ok(h.services.pools.names().includes('warehouse'));
    // datasources.d/ default is fail-closed
    assert.equal(h.services.pools.getConfig('warehouse').writable, false);
});

test('a no-op SIGHUP churns nothing: same pool object, no re-ping, no re-probe', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    const poolBefore = h.services.pools.getPool('main');

    const report = await reloadConfig(h.services, opts(h));

    assert.equal(report.ok, true, report.refusedReason);
    assert.deepEqual(report.changed, []);
    assert.deepEqual(report.added, []);
    assert.deepEqual(report.removed, []);
    // Identity, not equality: a rebuilt-then-swapped pool would compare equal by value
    // while having dropped every warm connection and re-run a 5s posture probe.
    assert.equal(h.services.pools.getPool('main'), poolBefore, 'an untouched datasource must keep its pool');
    // No posture line for `main` — reload cost stays proportional to the diff, and an
    // operator reloading for an unrelated datasource does not get their live pool churned.
    const postureLines = h.logs.filter((l) => String(l.msg).includes('read-only posture'));
    assert.deepEqual(postureLines, []);
});

test('SECURITY: a name defined in BOTH .env and datasources.d/ refuses the whole reload, naming it', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    writeDsFile(h, 'main', WAREHOUSE); // collides with .env's DATASOURCES=main
    const before = h.services.pools.names();

    const report = await reloadConfig(h.services, opts(h));

    assert.equal(report.ok, false);
    assert.match(report.refusedReason ?? '', /main/);
    assert.match(report.refusedReason ?? '', /both|collision|defined in/i);
    // A credential must never be silently overridden by the other source.
    assert.deepEqual(h.services.pools.names(), before);
});

test('SECURITY: a bad-permission file refuses the reload; no partially-applied state', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    writeDsFile(h, 'warehouse', WAREHOUSE, 0o644);
    const before = h.services.pools.names();

    const report = await reloadConfig(h.services, opts(h));

    assert.equal(report.ok, false);
    assert.match(report.refusedReason ?? '', /chmod 600/);
    assert.deepEqual(h.services.pools.names(), before);
});

test('a zod failure leaves the previous config bit-for-bit unchanged', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    writeDsFile(h, 'warehouse', 'HOST=warehouse.internal\nUSER=agent_ro\n'); // no DATABASE → zod fails
    const beforeNames = h.services.pools.names();
    const beforeTokens = tokenFingerprint(h.services);
    const beforeConfig = h.services.config;

    const report = await reloadConfig(h.services, opts(h));

    assert.equal(report.ok, false);
    assert.deepEqual(h.services.pools.names(), beforeNames);
    assert.equal(tokenFingerprint(h.services), beforeTokens);
    assert.equal(h.services.config, beforeConfig, 'services.config must not be reassigned on refusal');
});

test('a token referencing an unknown datasource refuses the reload', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h, 'TOKEN_AGENT_RO_DATASOURCES=ghost');
    const before = h.services.pools.names();

    const report = await reloadConfig(h.services, opts(h));

    assert.equal(report.ok, false);
    assert.match(report.refusedReason ?? '', /ghost/);
    assert.deepEqual(h.services.pools.names(), before);
});

test('SECURITY: a reload REMOVING the token the MCP process runs as is refused, naming the id', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    // agent_ro is gone from TOKENS entirely.
    writeFileSync(
        h.envPath,
        [
            'DATASOURCES=main',
            'DS_MAIN_HOST=localhost',
            'DS_MAIN_USER=postgres',
            'DS_MAIN_DATABASE=appdb',
            'TOKENS=svc_rw',
            'TOKEN_SVC_RW_SECRET=rw-secret',
            'TOKEN_SVC_RW_DATASOURCES=main',
            'TOKEN_SVC_RW_MODE=write',
            'TOKEN_SVC_RW_SCHEMAS=public',
        ].join('\n'),
    );

    const report = await reloadConfig(h.services, opts(h, { mcpToken: 'ro-secret', identity: 'agent_ro' }));

    assert.equal(report.ok, false);
    assert.match(report.refusedReason ?? '', /agent_ro/);
    // The live process would otherwise be unable to authorize its own tool calls.
    assert.equal(tokenFingerprint(h.services), INTACT);
});

test('SECURITY: a reload that ROTATES the MCP token secret is refused too (re-authenticated, not id-matched)', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    // Same id, different secret — an id-only check would wave this through.
    writeEnv(h, 'TOKEN_AGENT_RO_SECRET=rotated-secret');

    const report = await reloadConfig(h.services, opts(h, { mcpToken: 'ro-secret', identity: 'agent_ro' }));

    assert.equal(report.ok, false);
    assert.match(report.refusedReason ?? '', /agent_ro/);
    assert.equal(tokenFingerprint(h.services), INTACT);
});

test('after ANY stage-1 refusal, pools.names() and token digests are identical to before', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    const beforeNames = h.services.pools.names();
    const beforeTokens = tokenFingerprint(h.services);

    // Three different stage-1 refusal causes, one after another.
    writeEnv(h);
    writeDsFile(h, 'warehouse', WAREHOUSE, 0o644); // permissions
    assert.equal((await reloadConfig(h.services, opts(h))).ok, false);
    chmodSync(join(h.dsDir, 'warehouse.env'), 0o600);

    writeDsFile(h, 'main', WAREHOUSE); // collision
    assert.equal((await reloadConfig(h.services, opts(h))).ok, false);
    rmSync(join(h.dsDir, 'main.env'));

    writeEnv(h, 'TOKEN_SVC_RW_DATASOURCES=ghost'); // cross-reference
    assert.equal((await reloadConfig(h.services, opts(h))).ok, false);

    assert.deepEqual(h.services.pools.names(), beforeNames);
    assert.equal(tokenFingerprint(h.services), beforeTokens);
});

// =================================================================================
// Stage 2 — probes degrade PER DATASOURCE
// =================================================================================

test('ping failure WITHHOLDS that datasource, logs it, and does not kill the process', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    writeDsFile(h, 'warehouse', WAREHOUSE);
    unreachableHosts.add('warehouse.internal');

    const report = await reloadConfig(h.services, opts(h));

    // Contrast with boot, which exits 1 here. Something is serving now; it must keep serving.
    assert.equal(report.ok, true);
    assert.deepEqual(report.added, []);
    assert.deepEqual(report.withheld.map((w) => w.name), ['warehouse']);
    assert.equal(h.services.pools.names().includes('warehouse'), false);
    assert.ok(h.services.pools.names().includes('main'), 'the healthy datasource keeps serving');
});

test('one datasource failing does not prevent a sibling in the same reload from publishing', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    writeDsFile(h, 'warehouse', WAREHOUSE);
    writeDsFile(h, 'reports', ['HOST=reports.internal', 'USER=agent_ro', 'DATABASE=reporting'].join('\n'));
    unreachableHosts.add('warehouse.internal');

    const report = await reloadConfig(h.services, opts(h));

    assert.deepEqual(report.added, ['reports']);
    assert.deepEqual(report.withheld.map((w) => w.name), ['warehouse']);
});

test('a token grant edited in .env changes that token reachable datasources with no restart', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h, 'TOKEN_AGENT_RO_DATASOURCES=main,warehouse');
    writeDsFile(h, 'warehouse', WAREHOUSE);

    assert.equal(h.services.auth.authenticate('Bearer ro-secret')?.datasources.includes('warehouse'), false);
    const report = await reloadConfig(h.services, opts(h));

    assert.equal(report.ok, true, report.refusedReason);
    assert.equal(h.services.auth.authenticate('Bearer ro-secret')?.datasources.includes('warehouse'), true);
});

test('SECURITY: a failed policy tightening surfaces as retainedPrevious in the report AND the log', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    writeDsFile(h, 'warehouse', WAREHOUSE);
    await reloadConfig(h.services, opts(h));
    assert.ok(h.services.pools.names().includes('warehouse'));

    // Operator TIGHTENS the datasource (adds a denied table) — a policy-only edit that
    // needs no network — but the host is now unreachable, so the pre-swap ping fails.
    // The looser previous policy stays live; that must not be reported as "withheld"
    // (= not available), and it must be visible in the human-readable summary, not only
    // in a structured field.
    unreachableHosts.add('warehouse.internal');
    writeDsFile(h, 'warehouse', `${WAREHOUSE}\nDENIED_TABLES=billing_accounts`);
    h.logs.length = 0; // assert on THIS reload's lines, not the setup reload's
    const report = await reloadConfig(h.services, opts(h));

    assert.deepEqual(report.withheld, [], 'a serving datasource must never be reported withheld');
    assert.deepEqual(report.retainedPrevious.map((r) => r.name), ['warehouse']);
    assert.ok(h.services.pools.names().includes('warehouse'), 'still serving');
    assert.deepEqual(h.services.pools.getConfig('warehouse').deniedTables, [], 'still on the PREVIOUS policy');

    const summary = h.logs.find((l) => l.fields.event === 'config-reload' && l.fields.outcome === 'applied');
    assert.match(String(summary?.msg), /retainedPrevious:1/, 'must appear in the eyeballed summary line');
    assert.ok(
        h.logs.some((l) => String(l.msg).includes('kept its PREVIOUS config')),
        'the reason must be logged per datasource, not swallowed',
    );
});

test('a removed datasource stops routing and drains', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    writeDsFile(h, 'warehouse', WAREHOUSE);
    await reloadConfig(h.services, opts(h));
    assert.ok(h.services.pools.names().includes('warehouse'));

    rmSync(join(h.dsDir, 'warehouse.env'));
    const report = await reloadConfig(h.services, opts(h));

    assert.deepEqual(report.removed, ['warehouse']);
    assert.equal(h.services.pools.names().includes('warehouse'), false);
});

test('SECURITY: the reload log names added/removed/changed/withheld and contains NO credential values', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    writeDsFile(h, 'warehouse', WAREHOUSE);

    await reloadConfig(h.services, opts(h));

    // Assert on the reload SECURITY EVENT specifically. A blanket scan over every captured
    // line would also cover the posture log, which legitimately reports `db_user` at boot
    // too — so a blanket assertion would either be wrong or pass only by accident of the
    // stub making the posture probe fail. Be precise about which line carries the contract.
    const event = h.logs.find((l) => l.fields.event === 'config-reload' && l.fields.outcome === 'applied');
    assert.ok(event, 'a reload must emit a security event');
    const eventDump = JSON.stringify(event);
    assert.match(eventDump, /warehouse/, 'the reload event must NAME what changed');
    for (const secret of ['s3cret-warehouse-pw', 'warehouse.internal', 'agent_ro']) {
        assert.equal(eventDump.includes(secret), false, `value "${secret}" leaked into the reload security event`);
    }

    // Passwords are the one class that must appear in NO log line, anywhere — the posture
    // log's db_user exception does not extend to them.
    const allLogs = JSON.stringify(h.logs);
    // `main`'s password matches makeConfig()'s fixture (it has to, or `main` compares as
    // changed on every reload), so it is not a distinguishable probe. `warehouse` is —
    // its password exists ONLY in the datasource file this reload just read.
    assert.equal(allLogs.includes('s3cret-warehouse-pw'), false, 'datasource password leaked into a log');
    assert.equal(allLogs.includes('ro-secret'), false, 'token secret leaked into a log');
    assert.equal(allLogs.includes('rw-secret'), false, 'token secret leaked into a log');
});

test('a changed RootConfig-backed boot-only key is NOT applied and warns, naming the key', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h, 'MAX_ROWS_CEILING=999\nPORT=9999');

    const report = await reloadConfig(h.services, opts(h));

    assert.equal(report.ok, true, report.refusedReason);
    assert.deepEqual(report.bootOnlyChanged.sort(), ['MAX_ROWS_CEILING', 'PORT']);
    const warned = h.logs.filter((l) => l.level === 'warn' && JSON.stringify(l).includes('MAX_ROWS_CEILING'));
    assert.ok(warned.length > 0, 'a changed boot-only key must warn that a restart is required');
});

test('a changed process.env-only boot-only key also warns (compared against baseEnv)', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h, 'HEALTH_CACHE_TTL_MS=60000');

    // baseEnv stands in for process.env, which production never mutates — that is what
    // makes it a valid baseline for keys zod never sees.
    const report = await reloadConfig(h.services, opts(h, { baseEnv: { HEALTH_CACHE_TTL_MS: '5000' } }));

    assert.ok(report.bootOnlyChanged.includes('HEALTH_CACHE_TTL_MS'));
});

test('an UNCHANGED boot-only key produces no warn', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h); // no boot-only keys at all → nothing differs

    const report = await reloadConfig(h.services, opts(h));

    assert.deepEqual(report.bootOnlyChanged, []);
});

test('the live MCP caps object is refreshed IN PLACE so registered handlers see new grants', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h, 'TOKEN_AGENT_RO_DATASOURCES=main,warehouse');
    writeDsFile(h, 'warehouse', WAREHOUSE);

    // Stand-in for the object registerTools() closed over at boot.
    const liveCaps = { ...h.services.auth.authenticate('Bearer ro-secret')! };
    const heldByHandler = liveCaps; // a handler keeps THIS reference forever

    await reloadConfig(h.services, opts(h, { liveCaps, mcpToken: 'ro-secret', identity: 'agent_ro' }));

    assert.equal(heldByHandler.datasources.includes('warehouse'), true, 'the handler must see the new grant');
    assert.equal(heldByHandler, liveCaps, 'refreshed in place — never replaced');
});

// =================================================================================
// Serialization (risk R9) — overlapping SIGHUPs must not interleave two reloads
// =================================================================================

test('overlapping triggers COALESCE into one trailing reload, never two in flight', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);

    // Count concurrency by watching the applied-log lines, which are emitted once per
    // completed reload.
    const runner = createReloadRunner(h.services, opts(h));

    runner.trigger(); // starts
    runner.trigger(); // in-flight → sets pending
    runner.trigger(); // in-flight → pending already set, must NOT queue a third
    runner.trigger();
    await runner.idle();

    const applied = h.logs.filter((l) => l.fields.event === 'config-reload' && l.fields.outcome === 'applied');
    // One for the initial run, exactly one trailing run for the coalesced signals.
    assert.equal(applied.length, 2, 'four triggers must collapse to two reloads, not four');
});

test('a trigger after the runner has gone idle starts a fresh reload', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    const runner = createReloadRunner(h.services, opts(h));

    runner.trigger();
    await runner.idle();
    runner.trigger();
    await runner.idle();

    const applied = h.logs.filter((l) => l.fields.event === 'config-reload' && l.fields.outcome === 'applied');
    assert.equal(applied.length, 2);
});

test('the trailing reload picks up an edit made DURING the in-flight one', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    const runner = createReloadRunner(h.services, opts(h));

    runner.trigger();
    // Operator edits while the first reload is still running — coalescing (rather than
    // dropping) is what makes this land without another signal.
    writeDsFile(h, 'warehouse', WAREHOUSE);
    runner.trigger();
    await runner.idle();

    assert.ok(h.services.pools.names().includes('warehouse'), 'the trailing run must apply the latest state on disk');
});

test('SECURITY: a token RENAME narrows the live MCP caps — refresh resolves by secret, not id', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    writeDsFile(h, 'warehouse', WAREHOUSE);
    await reloadConfig(h.services, opts(h, { mcpToken: 'ro-secret', identity: 'agent_ro' }));

    // The process runs as `agent_ro`, currently able to reach everything.
    const liveCaps = { ...h.services.auth.authenticate('Bearer ro-secret')! };
    const heldByHandler = liveCaps;
    assert.equal(heldByHandler.datasources.includes('*'), false);

    // Operator RENAMES the id and narrows it in the same edit, keeping the secret.
    // Stage 1 authenticates by SECRET so this passes — and an id-based refresh would then
    // find nothing under the OLD id and silently skip, leaving the handler on the old,
    // WIDER grants: a revocation that reports success and does nothing. Renaming is the
    // natural way to narrow an identity, because REMOVING the token is refused wholesale.
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
            'TOKENS=agent_narrowed,svc_rw',
            'TOKEN_AGENT_NARROWED_SECRET=ro-secret',
            'TOKEN_AGENT_NARROWED_DATASOURCES=main',
            'TOKEN_AGENT_NARROWED_MODE=read',
            'TOKEN_AGENT_NARROWED_SCHEMAS=public',
            'TOKEN_SVC_RW_SECRET=rw-secret',
            'TOKEN_SVC_RW_DATASOURCES=main',
            'TOKEN_SVC_RW_MODE=write',
            'TOKEN_SVC_RW_SCHEMAS=public',
        ].join('\n'),
    );

    const report = await reloadConfig(h.services, opts(h, { liveCaps, mcpToken: 'ro-secret', identity: 'agent_ro' }));

    assert.equal(report.ok, true, report.refusedReason);
    assert.equal(heldByHandler.id, 'agent_narrowed', 'the live caps must follow the rename');
    assert.deepEqual(heldByHandler.datasources, ['main'], 'the revocation must actually reach the handler');
    assert.deepEqual(heldByHandler.schemas, ['public']);
    assert.equal(heldByHandler, liveCaps, 'refreshed in place — never replaced');
});

test('SECURITY: the refreshed live caps do NOT alias the token store', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h, 'TOKEN_AGENT_RO_DATASOURCES=main,warehouse');
    writeDsFile(h, 'warehouse', WAREHOUSE);

    const liveCaps = { ...h.services.auth.authenticate('Bearer ro-secret')! };
    await reloadConfig(h.services, opts(h, { liveCaps, mcpToken: 'ro-secret', identity: 'agent_ro' }));
    assert.deepEqual(liveCaps.datasources.sort(), ['main', 'warehouse']);

    // liveCaps is held for the process lifetime by every registered handler. If the
    // refresh assigned the STORE's own arrays, a later mutation here would silently widen
    // the stored token's grants for every subsequent request.
    liveCaps.datasources.push('ghost');
    liveCaps.schemas.push('ghost_schema');

    const fromStore = h.services.auth.authenticate('Bearer ro-secret')!;
    assert.equal(fromStore.datasources.includes('ghost'), false, 'the token store was widened by a mutation of live caps');
    assert.equal(fromStore.schemas.includes('ghost_schema'), false);
});

test('liveCaps WITHOUT mcpToken is not refreshed, and says so', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h, 'TOKEN_AGENT_RO_DATASOURCES=main,warehouse');
    writeDsFile(h, 'warehouse', WAREHOUSE);

    // The secret is the only thing that identifies this process across a rename, so a
    // refresh without it cannot be done safely. It must be loud rather than silent.
    const liveCaps = { ...h.services.auth.authenticate('Bearer ro-secret')! };
    await reloadConfig(h.services, opts(h, { liveCaps }));

    assert.equal(liveCaps.datasources.includes('warehouse'), false, 'must NOT refresh without the secret');
    assert.ok(
        h.logs.some((l) => l.level === 'warn' && String(l.msg).includes('NOT refreshed')),
        'a skipped refresh must be announced, never silent',
    );
});

test('changed + removed datasources have their health verdicts invalidated', async (t) => {
    const h = harness();
    t.after(h.cleanup);
    writeEnv(h);
    const stub = h.services.driver as StubDriver;

    await h.services.health.check('main'); // seed the cache
    const afterSeed = stub.pingCount;

    writeEnv(h, 'DS_MAIN_STATEMENT_TIMEOUT_MS=20000'); // main is now CHANGED
    await reloadConfig(h.services, opts(h));
    await h.services.health.check('main');

    // Without invalidation this would serve the pre-swap verdict for a full TTL window.
    assert.equal(stub.pingCount, afterSeed + 1, 'a changed datasource must be re-pinged, not served from cache');
});
