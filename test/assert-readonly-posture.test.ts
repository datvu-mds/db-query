import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import pino from 'pino';
import { makeConfig, StubDriver, emptyResult } from './helpers.js';
import type { RootConfig } from '../src/config/config.schema.js';
import type { Services } from '../src/services.js';

/**
 * Counting wrapper around libpg-query's `parse` — the ONLY way to observe the boot
 * warm-up. On success `extractSqlRefs('SELECT 1')` has no external effect, and
 * libpg-query starts its own WASM init at import time, so "the parser works
 * afterwards" proves nothing about whether the warm-up ran.
 *
 * libpg-query is CJS: its named ESM import is SNAPSHOTTED when `relation-guard` is
 * first linked, so this wrapper must be installed BEFORE that link — hence the
 * dynamic imports below. (Verified: patching after the link counts 0 calls.)
 *
 * INVARIANT: no static import in this file may reach libpg-query. Today only
 * `../src/boot/assert-readonly-posture.js` and `../src/services.js` do (via
 * query-service → relation-guard); `./helpers.js` does not. Adding such a static
 * import makes the "boot still warms the parser" assertion count 0 and fail loudly
 * rather than silently pass.
 */
const nodeRequire = createRequire(import.meta.url);
const libpg = nodeRequire('libpg-query') as { parse: (sql: string) => Promise<unknown> };
const realParse = libpg.parse;
let parseCalls = 0;
libpg.parse = (sql: string) => {
    parseCalls++;
    return realParse(sql);
};

const { assertReadOnlyPosture } = await import('../src/boot/assert-readonly-posture.js');
const { buildServices } = await import('../src/services.js');

interface Line extends Record<string, unknown> {
    level: number;
    msg: string;
}

const WARN = 40;
const INFO = 30;

function capture(): { logger: pino.Logger; lines: Line[] } {
    const lines: Line[] = [];
    const stream = { write: (s: string) => lines.push(JSON.parse(s) as Line) };
    return { logger: pino({ level: 'info' }, stream), lines };
}

type Row = Record<string, unknown>;

/** A probe row shaped exactly like the one PROBE_SQL returns. */
function postureRow(over: Partial<Row> = {}): Row {
    return {
        db_user: 'agent_ro_pg',
        default_read_only: 'on',
        is_superuser: false,
        write_all_data: false,
        writable_relations: 0,
        ...over,
    };
}

function result(rows: Row[]) {
    return { ...emptyResult('SELECT'), rows, rowCount: rows.length };
}

const built: Services[] = [];
after(() => Promise.all(built.map((s) => s.pools.drainAll())));

/** Wire real services (PoolManager included) over a stub driver — no live PG. */
function setup(opts: { rows?: Row[]; fail?: Error | string; config?: RootConfig }) {
    const { logger, lines } = capture();
    const stub = new StubDriver();
    if (opts.fail !== undefined) stub.userError = opts.fail as Error;
    else stub.userResult = result(opts.rows ?? [postureRow()]);
    const services = buildServices(opts.config ?? makeConfig(), logger, stub);
    built.push(services);
    return { services, lines, stub };
}

/** Config whose only token is read-mode (the intended production posture). */
function readOnlyTokenConfig(): RootConfig {
    return makeConfig({ tokens: [{ id: 'agent_ro', secret: 's', datasources: ['main'], mode: 'read', schemas: ['*'] }] });
}

const posture = (lines: Line[]): Line => lines.find((l) => typeof l.msg === 'string' && l.msg.includes('read-only posture'))!;

test('no writable relations + read-only default → info, backstop true', async () => {
    const { services, lines } = setup({ config: readOnlyTokenConfig() });
    await assertReadOnlyPosture(services);

    const line = posture(lines);
    assert.ok(line, 'a posture line was logged');
    assert.equal(line.level, INFO);
    assert.equal(line.backstop, true);
    assert.equal(line.writableRelations, 0);
    assert.equal(line.dbUser, 'agent_ro_pg');
    assert.match(line.msg, /posture OK/);
    assert.match(line.msg, /defaults transactions to read-only/);
});

test('no writable relations but default_transaction_read_only off → still OK, grants are the real barrier', async () => {
    const { services, lines } = setup({ rows: [postureRow({ default_read_only: 'off' })], config: readOnlyTokenConfig() });
    await assertReadOnlyPosture(services);

    const line = posture(lines);
    assert.equal(line.level, INFO);
    assert.equal(line.backstop, true);
    assert.equal(line.defaultReadOnly, false);
    assert.match(line.msg, /grants are the real barrier/);
});

test('write-capable role + write-mode token → WARN that the DB is not the backstop', async () => {
    // makeConfig ships a write-mode svc_rw token scoped to main.
    const { services, lines } = setup({ rows: [postureRow({ default_read_only: 'off', writable_relations: 1838 })] });
    await assertReadOnlyPosture(services);

    const line = posture(lines);
    assert.equal(line.level, WARN);
    assert.equal(line.backstop, false);
    assert.equal(line.writableRelations, 1838);
    assert.deepEqual(line.writeTokens, ['svc_rw']);
    assert.match(line.msg, /DB is NOT the read-only backstop/);
});

test('write-capable role with no write token → WARN that only app logic prevents writes', async () => {
    const { services, lines } = setup({ rows: [postureRow({ writable_relations: 1838 })], config: readOnlyTokenConfig() });
    await assertReadOnlyPosture(services);

    const line = posture(lines);
    assert.equal(line.level, WARN);
    assert.equal(line.backstop, false);
    assert.deepEqual(line.writeTokens, []);
    assert.match(line.msg, /only app logic prevents writes/);
});

test("a '*' datasource write token counts as reaching this datasource", async () => {
    const config = makeConfig({ tokens: [{ id: 'wild_rw', secret: 's', datasources: ['*'], mode: 'write', schemas: ['*'] }] });
    const { services, lines } = setup({ rows: [postureRow({ writable_relations: 1 })], config });
    await assertReadOnlyPosture(services);

    assert.deepEqual(posture(lines).writeTokens, ['wild_rw']);
    assert.match(posture(lines).msg, /DB is NOT the read-only backstop/);
});

// The blanket capabilities leave NO per-table ACL row, so a relation count of 0 is
// not evidence of safety on its own — these two must independently defeat backstop.
test('superuser is never a backstop even with zero writable relations', async () => {
    const { services, lines } = setup({ rows: [postureRow({ is_superuser: true })], config: readOnlyTokenConfig() });
    await assertReadOnlyPosture(services);

    const line = posture(lines);
    assert.equal(line.level, WARN);
    assert.equal(line.backstop, false);
    assert.equal(line.isSuperuser, true);
});

test('pg_write_all_data membership is never a backstop even with zero writable relations', async () => {
    const { services, lines } = setup({ rows: [postureRow({ write_all_data: true })], config: readOnlyTokenConfig() });
    await assertReadOnlyPosture(services);

    const line = posture(lines);
    assert.equal(line.level, WARN);
    assert.equal(line.backstop, false);
    assert.equal(line.writeAllData, true);
});

test('probe failure is reported as UNVERIFIED and never throws', async () => {
    const { services, lines } = setup({ fail: new Error('permission denied for view pg_class') });
    await assert.doesNotReject(() => assertReadOnlyPosture(services));

    const line = lines.find((l) => l.msg.includes('UNVERIFIED'))!;
    assert.ok(line, 'an UNVERIFIED line was logged');
    assert.equal(line.level, WARN);
    assert.match(String(line.err), /permission denied/);
});

test('a non-Error throw still reports a usable message', async () => {
    const { services, lines } = setup({ fail: 'string blow-up' });
    await assert.doesNotReject(() => assertReadOnlyPosture(services));
    assert.match(String(lines.find((l) => l.msg.includes('UNVERIFIED'))!.err), /string blow-up/);
});

// FAIL CLOSED. Each of these previously collapsed into "0 → backstop true → OK",
// which is the one outcome a security check must never produce by accident.
test('an empty result set is UNVERIFIED, never OK', async () => {
    const { services, lines } = setup({ rows: [], config: readOnlyTokenConfig() });
    await assertReadOnlyPosture(services);

    assert.equal(lines.some((l) => l.msg.includes('posture OK')), false, 'must not claim OK');
    assert.match(lines.find((l) => l.msg.includes('UNVERIFIED'))!.msg, /UNVERIFIED/);
});

// Number(null) === 0 and Number('') === 0, so a loose read of these values reports
// "nothing writable → OK". Each must land in UNVERIFIED instead.
test('a missing or unparseable writableRelations column is UNVERIFIED, never OK', async () => {
    for (const value of [undefined, null, '', 'not-a-number', NaN, false, -1, 1.5, {}]) {
        const rows = [{ ...postureRow(), writable_relations: value }];
        const { services, lines } = setup({ rows, config: readOnlyTokenConfig() });
        await assertReadOnlyPosture(services);

        assert.equal(lines.some((l) => l.msg.includes('posture OK')), false, `must not claim OK for ${JSON.stringify(value)}`);
        assert.ok(
            lines.some((l) => l.msg.includes('UNVERIFIED')),
            `expected UNVERIFIED for writableRelations=${JSON.stringify(value)}`,
        );
    }
});

// `undefined === true` is false, so a loose read of these would let a missing column
// silently satisfy "not a superuser / no blanket write role".
test('a missing or non-boolean capability column is UNVERIFIED, never OK', async () => {
    for (const column of ['is_superuser', 'write_all_data']) {
        for (const value of [undefined, null, 'false', 0]) {
            const rows = [{ ...postureRow(), [column]: value }];
            const { services, lines } = setup({ rows, config: readOnlyTokenConfig() });
            await assertReadOnlyPosture(services);

            const label = `${column}=${JSON.stringify(value)}`;
            assert.equal(lines.some((l) => l.msg.includes('posture OK')), false, `must not claim OK for ${label}`);
            assert.ok(lines.some((l) => l.msg.includes('UNVERIFIED')), `expected UNVERIFIED for ${label}`);
        }
    }
});

test('a numeric-string count (bigint over the wire) is accepted', async () => {
    const { services, lines } = setup({ rows: [{ ...postureRow(), writable_relations: '0' }], config: readOnlyTokenConfig() });
    await assertReadOnlyPosture(services);
    assert.match(posture(lines).msg, /posture OK/);
    assert.equal(posture(lines).writableRelations, 0);
});

test('the running identity is recorded so the write-token signal is not diluted', async () => {
    const { services, lines } = setup({});
    await assertReadOnlyPosture(services, 'agent_ro');
    assert.equal(posture(lines).identity, 'agent_ro');
});

test('probe runs through the audited read-only transaction path', async () => {
    const { services, stub } = setup({ config: readOnlyTokenConfig() });
    await assertReadOnlyPosture(services);

    // Read path, not write path: the txn must be opened READ ONLY and scrubbed after.
    const sqls = stub.sqls();
    assert.equal(sqls[0], 'BEGIN TRANSACTION READ ONLY');
    assert.ok(sqls.includes('DISCARD ALL'));

    // Exactly one caller statement, and it is the posture probe.
    const user = stub.userStatements();
    assert.equal(user.length, 1);
    assert.match(user[0].sql, /default_transaction_read_only/);
    // Capability-based, not ACL-row-based: an information_schema.table_privileges
    // count cannot see column grants, pg_write_all_data, or superuser.
    assert.match(user[0].sql, /has_table_privilege/);
    assert.match(user[0].sql, /has_any_column_privilege/);
    assert.match(user[0].sql, /pg_write_all_data/);
    assert.doesNotMatch(user[0].sql, /table_privileges/);
});

// Regression: Postgres folds unquoted identifiers to lower case, so `AS writableFoo`
// arrives as `writablefoo` and every camelCase row lookup silently misses. That is how
// the live probe first came back UNVERIFIED. Any alias with an upper-case letter is a bug.
test('every probe column alias is lower-case, so row lookups cannot miss', async () => {
    const { services, stub } = setup({});
    await assertReadOnlyPosture(services);

    const sql = stub.userStatements()[0].sql;
    const aliases = [...sql.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    assert.ok(aliases.length >= 5, `expected the probe's aliases, found ${aliases.length}`);
    for (const alias of aliases) {
        assert.equal(alias, alias.toLowerCase(), `alias "${alias}" would be case-folded by Postgres`);
    }
});

// --- opts: subset probing + warm-up control (the reload path) -----------------
// Reload calls this per diff. Without a subset, adding ONE datasource re-probes every
// datasource (up to PROBE_TIMEOUT_MS each) and re-emits the whole posture log, so these
// assert PROBE COUNT — a regression here must fail a test, not merely make reload slow.

/** Two datasources off the shared fixture, so a new required DatasourceConfig field
 *  cannot silently miss the second one. Only `main` has a write-mode token. */
function twoDatasourceConfig(): RootConfig {
    const base = makeConfig().datasources[0];
    return makeConfig({ datasources: [base, { ...base, name: 'other' }] });
}

/** Every posture verdict line, in order, so we can assert WHICH datasources were probed
 *  (StubDriver.connect ignores the name, so a count alone cannot prove identity). */
const postureLines = (lines: Line[]): Line[] => lines.filter((l) => typeof l.msg === 'string' && l.msg.includes('read-only posture'));

test('opts.only probes exactly the named datasources — an unaffected one is never re-probed', async () => {
    const { services, lines, stub } = setup({ config: twoDatasourceConfig() });
    await assertReadOnlyPosture(services, undefined, { only: ['other'] });

    assert.equal(stub.connectCount, 1, 'exactly one probe — reload cost must track the diff, not the datasource count');
    assert.deepEqual(
        postureLines(lines).map((l) => l.datasource),
        ['other'],
    );
});

test('omitting opts probes every datasource — boot behaviour unchanged', async () => {
    const { services, lines, stub } = setup({ config: twoDatasourceConfig() });
    await assertReadOnlyPosture(services);

    assert.equal(stub.connectCount, 2);
    assert.deepEqual(
        postureLines(lines).map((l) => l.datasource),
        ['main', 'other'],
    );
});

// `opts.only?.length ? only : names()` would silently re-probe EVERYTHING for a reload
// whose diff is empty — the exact regression this parameter exists to prevent.
test('an empty opts.only probes nothing — it never falls back to every datasource', async () => {
    const { services, lines, stub } = setup({ config: twoDatasourceConfig() });
    await assertReadOnlyPosture(services, undefined, { only: [] });

    assert.equal(stub.connectCount, 0);
    assert.deepEqual(postureLines(lines), []);
});

// FAIL CLOSED. `only` is deliberately NOT filtered against names() (a reload probes a
// STAGED datasource, resolvable but not yet routable), so an unresolvable name must be
// reported, never dropped in silence — and must not abort the rest of the subset.
test('a name in opts.only that resolves to no datasource is UNVERIFIED, never OK, and never throws', async () => {
    const { services, lines, stub } = setup({ config: twoDatasourceConfig() });
    await assert.doesNotReject(() => assertReadOnlyPosture(services, 'agent_ro', { only: ['ghost', 'other'] }));

    const line = lines.find((l) => l.msg.includes('UNVERIFIED'))!;
    assert.ok(line, 'an UNVERIFIED line was logged for the unresolvable name');
    assert.equal(line.level, WARN);
    assert.equal(line.datasource, 'ghost');
    assert.match(line.msg, /read-only posture/);

    // Nothing else may be said about a datasource that does not exist — a refactor that
    // hoisted the guard-status logging above the resolve would announce "relation guard
    // ENFORCED for datasource ghost" about a datasource nobody configured.
    assert.equal(
        lines.some((l) => typeof l.msg === 'string' && l.msg.includes('"ghost"')),
        false,
        'no guard-status line for a datasource that does not resolve',
    );

    // The rest of the subset is still probed, exactly once.
    assert.equal(stub.connectCount, 1);
    const ok = lines.find((l) => l.msg.includes('posture OK'))!;
    assert.equal(ok.datasource, 'other');
});

test('the parser warm-up runs at boot, is skipped on warmParser:false, and defaults to true', async () => {
    const { services } = setup({ config: readOnlyTokenConfig() });

    parseCalls = 0;
    await assertReadOnlyPosture(services, undefined, { warmParser: false });
    assert.equal(parseCalls, 0, 'reload must not re-pay the WASM warm-up');

    parseCalls = 0;
    await assertReadOnlyPosture(services);
    assert.equal(parseCalls, 1, 'boot still warms the parser so the first user query does not pay for it');

    parseCalls = 0;
    await assertReadOnlyPosture(services, undefined, { only: ['main'] });
    assert.equal(parseCalls, 1, 'warmParser defaults to true when opts omits it');
});

// --- datasource write gate visibility -------------------------------------------
// WRITABLE is off by default from every config source, so a writable datasource is
// always a deliberate act. Deliberate acts that re-open a write path must be as loud
// at boot as ALLOW_UNSAFE_STATEMENTS — otherwise the only record that a gateway
// advertised as read-only can in fact write is one line in a .env nobody re-reads.

const writableWarn = (lines: Line[]): Line | undefined =>
    lines.find((l) => typeof l.msg === 'string' && l.msg.includes('is WRITABLE'));

test('SECURITY: a writable datasource produces a boot WARN naming it', async () => {
    const cfg = makeConfig(); // shared fixture is writable:true
    const { services, lines } = setup({ config: cfg });
    await assertReadOnlyPosture(services);

    const warn = writableWarn(lines);
    assert.ok(warn, 'a writable datasource must be announced at boot');
    assert.equal(warn.level, WARN, 'must be WARN, not INFO — this re-opens a write path');
    assert.equal(warn.datasource, 'main');
    assert.equal(warn.writable, true);
});

test('a read-only datasource produces NO writable warn (the default must be quiet)', async () => {
    // If the default were noisy, operators would learn to ignore the line that matters.
    const cfg = makeConfig({ datasources: [{ ...makeConfig().datasources[0], writable: false }] });
    const { services, lines } = setup({ config: cfg });
    await assertReadOnlyPosture(services);

    assert.equal(writableWarn(lines), undefined);
});

// --- upgrade safety net: write tokens with nothing writable ----------------------
// WRITABLE now defaults FALSE from every source, which is deliberate but NOT backward
// compatible. Without this warning the only signal an upgraded deployment gets is a 403
// on whatever production write happens to run first.

const unreachableWarn = (lines: Line[]): Line | undefined =>
    lines.find((l) => typeof l.msg === 'string' && l.msg.includes('NO datasource is writable'));

test('SECURITY: write tokens + nothing writable warns at boot, naming the tokens', async () => {
    const cfg = makeConfig({ datasources: [{ ...makeConfig().datasources[0], writable: false }] });
    const { services, lines } = setup({ config: cfg }); // makeConfig ships a write-mode svc_rw
    await assertReadOnlyPosture(services);

    const warn = unreachableWarn(lines);
    assert.ok(warn, 'an upgraded deployment must be told its write path is closed');
    assert.equal(warn.level, WARN);
    assert.deepEqual(warn.writeTokens, ['svc_rw']);
    assert.match(String(warn.msg), /DS_<NAME>_WRITABLE=true/, 'must name the fix');
});

test('no warning when at least one datasource IS writable', async () => {
    const { services, lines } = setup({ config: makeConfig() }); // fixture is writable:true
    await assertReadOnlyPosture(services);
    assert.equal(unreachableWarn(lines), undefined);
});

test('no warning when there are no write-mode tokens (an intentionally read-only gateway)', async () => {
    // The common, correct configuration must stay silent — a warning that fires for
    // everyone is one operators learn to skip past.
    const cfg = makeConfig({
        datasources: [{ ...makeConfig().datasources[0], writable: false }],
        tokens: [{ id: 'agent_ro', secret: 's', datasources: ['main'], mode: 'read', schemas: ['*'] }],
    });
    const { services, lines } = setup({ config: cfg });
    await assertReadOnlyPosture(services);

    assert.equal(unreachableWarn(lines), undefined);
});

test('the writes-unreachable warning is BOOT-only — a reload subset must not claim it', async () => {
    // On reload `only` is the DIFF. Warning from a one-element subset would assert
    // "NO datasource is writable" while other writable datasources are live and serving.
    const cfg = makeConfig({
        datasources: [
            { ...makeConfig().datasources[0], name: 'ro_one', writable: false },
            { ...makeConfig().datasources[0], name: 'writable_one', writable: true },
        ],
    });
    const { services, lines } = setup({ config: cfg });
    await assertReadOnlyPosture(services, undefined, { only: ['ro_one'], warmParser: false });

    assert.equal(unreachableWarn(lines), undefined, 'a reload subset must not conclude anything about the fleet');
});
