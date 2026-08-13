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

test('invalidate() drops the cached verdict so the next check re-pings', async () => {
    const stub = new StubDriver();
    const hc = new HealthChecker(stub, 10000);
    assert.equal(await hc.check('main'), true);
    assert.equal(stub.pingCount, 1);

    hc.invalidate('main');

    assert.equal(await hc.check('main'), true);
    assert.equal(stub.pingCount, 2); // cache dropped → re-pinged well inside the TTL
});

test('a changed datasource does not serve its pre-swap verdict from cache', async () => {
    const stub = new StubDriver();
    stub.pingError = new Error('down'); // the pre-swap pool pointed at a dead host
    const hc = new HealthChecker(stub, 10000);
    assert.equal(await hc.check('main'), false);

    // Reload swapped the pool for a healthy one; without invalidate the checker would keep
    // answering `false` about a pool that no longer exists for the rest of the TTL window.
    stub.pingError = null;
    hc.invalidate('main');

    assert.equal(await hc.check('main'), true);
    assert.equal(stub.pingCount, 2);
});

test('invalidate() leaves an unaffected datasource cached', async () => {
    const stub = new StubDriver();
    const hc = new HealthChecker(stub, 10000);
    await hc.check('changed');
    await hc.check('untouched');
    assert.equal(stub.pingCount, 2);

    hc.invalidate('changed');

    assert.equal(await hc.check('untouched'), true);
    assert.equal(stub.pingCount, 2); // untouched keeps its entry → no needless re-ping
    assert.equal(await hc.check('changed'), true);
    assert.equal(stub.pingCount, 3); // only the invalidated name re-pings
});

test('a ping in flight across invalidate() does not re-seed the cache', async () => {
    // StubDriver.ping resolves immediately, so gate the FIRST ping open across the invalidate()
    // — that is the window in which the pool is swapped underneath us. It fails, the way a pool
    // pointed at a since-replaced host would, so the two verdicts are distinguishable.
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let calls = 0;
    class GatedDriver extends StubDriver {
        override async ping(): Promise<void> {
            const nth = ++calls; // fixed at call time, before any await can interleave
            await super.ping(); // keeps StubDriver.pingCount authoritative for the assertions
            if (nth === 1) {
                await gate;
                throw new Error('down');
            }
        }
    }
    const stub = new GatedDriver();
    const hc = new HealthChecker(stub, 10000);

    const preSwap = hc.check('main'); // in flight against the OLD pool
    hc.invalidate('main');

    // A probe arriving after the swap must not be answered by the old pool's ping.
    const postSwap = hc.check('main');
    assert.equal(await postSwap, true);
    assert.equal(stub.pingCount, 2); // it started its own ping instead of joining the orphan

    openGate();
    assert.equal(await preSwap, false); // the orphan still answers its own caller honestly

    // …but its verdict must not land in the cache, or /health would serve the pre-swap answer
    // for the rest of the TTL — exactly what invalidate() dropped.
    assert.equal(await hc.check('main'), true);
    assert.equal(stub.pingCount, 2);
});
