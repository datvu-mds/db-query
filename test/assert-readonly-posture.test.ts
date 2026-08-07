import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { assertReadOnlyPosture } from '../src/boot/assert-readonly-posture.js';
import { buildServices } from '../src/services.js';
import { makeConfig, StubDriver, emptyResult } from './helpers.js';
import type { RootConfig } from '../src/config/config.schema.js';
import type { Services } from '../src/services.js';

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
