/**
 * PostgresDriver — asserts the wire-protocol choice, which is a SECURITY property,
 * not a perf detail.
 *
 * `pg` picks the protocol from whether params were supplied: with none it uses the
 * simple protocol, which executes `a; b` from a single call. That is what let a
 * caller smuggle `COMMIT` past the text-level guard and out of
 * `BEGIN TRANSACTION READ ONLY`. Forcing `queryMode:'extended'` moves the rejection
 * into the server. If this test fails, multi-statement smuggling is live again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDriver } from '../src/driver/postgres-driver.js';
import type { PoolManager } from '../src/pool/pool-manager.js';

interface Captured {
    text: string;
    values?: unknown[];
    queryMode?: string;
}

/** Minimal PoolManager stand-in whose client records the query config it receives. */
function driverWithCapture(): { driver: PostgresDriver; calls: Captured[] } {
    const calls: Captured[] = [];
    const client = {
        query: async (config: Captured) => {
            calls.push(config);
            return { fields: [], rows: [], rowCount: 0, command: 'SELECT' };
        },
        release: () => undefined,
    };
    const pools = { getPool: () => ({ connect: async () => client }) } as unknown as PoolManager;
    return { driver: new PostgresDriver(pools), calls };
}

test('forces the extended protocol even with no params', async () => {
    const { driver, calls } = driverWithCapture();
    const conn = await driver.connect('main');
    await conn.exec('SELECT 1');
    assert.equal(calls[0].queryMode, 'extended');
    assert.equal(calls[0].text, 'SELECT 1');
    assert.equal(calls[0].values, undefined);
});

test('forces the extended protocol for parameterized queries too', async () => {
    const { driver, calls } = driverWithCapture();
    const conn = await driver.connect('main');
    await conn.exec('SELECT $1::int', [7]);
    assert.equal(calls[0].queryMode, 'extended');
    assert.deepEqual(calls[0].values, [7]);
});

test('control statements also go through the extended protocol', async () => {
    const { driver, calls } = driverWithCapture();
    const conn = await driver.connect('main');
    for (const sql of ['BEGIN TRANSACTION READ ONLY', 'SET LOCAL search_path TO "public", pg_temp', 'COMMIT', 'DISCARD ALL']) {
        await conn.exec(sql);
    }
    assert.ok(calls.every((c) => c.queryMode === 'extended'));
    assert.equal(calls.length, 4);
});
