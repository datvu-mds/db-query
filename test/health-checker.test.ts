import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HealthChecker } from '../src/pool/health-checker.js';
import { StubDriver } from './helpers.js';

test('dedupes concurrent pings and caches within TTL', async () => {
    const stub = new StubDriver();
    const hc = new HealthChecker(stub, 10000);
    const results = await Promise.all([hc.check('main'), hc.check('main'), hc.check('main')]);
    assert.deepEqual(results, [true, true, true]);
    assert.equal(stub.pingCount, 1); // three concurrent probes → one ping
    await hc.check('main'); // within TTL → cached
    assert.equal(stub.pingCount, 1);
});

test('reports false (and caches it) when the ping fails', async () => {
    const stub = new StubDriver();
    stub.pingError = new Error('down');
    const hc = new HealthChecker(stub, 10000);
    assert.equal(await hc.check('main'), false);
    assert.equal(await hc.check('main'), false);
    assert.equal(stub.pingCount, 1); // failed result also cached
});

test('TTL=0 re-pings on every check', async () => {
    const stub = new StubDriver();
    const hc = new HealthChecker(stub, 0);
    await hc.check('main');
    await hc.check('main');
    assert.equal(stub.pingCount, 2);
});
