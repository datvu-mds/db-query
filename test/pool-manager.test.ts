/**
 * PoolManager.applyDatasources — the in-place diff that reload rides on.
 *
 * These tests subclass PoolManager to substitute a fake pg.Pool, so the whole
 * add / replace-and-drain / remove state machine is exercised with no live
 * Postgres. What they are really guarding is Design Decision 11: `names()` is the
 * ROUTABLE set, while `getPool`/`getConfig` additionally resolve STAGED and
 * DRAINING entries. Every request path gates on `names()` first, so a staged
 * datasource is unreachable by callers while it is probed — and a removed one
 * stays resolvable through its drain window instead of surfacing a spurious 500.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool as PgPool } from 'pg';
import { PoolManager } from '../src/pool/pool-manager.js';
import type { DatasourceConfig } from '../src/config/config.schema.js';
import { silentLogger, makeConfig } from './helpers.js';

/** Minimal stand-in for pg.Pool: records end() and the mandatory error handler. */
class FakePool {
    ended = false;
    errorHandlers = 0;
    totalCount = 0;
    endResolve: (() => void) | null = null;
    /** When set, end() blocks until releaseDrain() is called (drain-window tests). */
    blockEnd = false;
    /** When set, connect() rejects — i.e. the datasource is unreachable. */
    connectError: Error | null = null;
    connects = 0;

    async connect(): Promise<{ query: () => Promise<unknown>; release: () => void }> {
        this.connects++;
        if (this.connectError) throw this.connectError;
        return { query: async () => ({ rows: [] }), release: () => undefined };
    }

    on(event: string, _fn: unknown): this {
        if (event === 'error') this.errorHandlers++;
        return this;
    }
    /**
     * Rejects on a SECOND call, exactly as `pg@8` does (`pool.js`: `if (this.ending)
     * … Promise.reject(new Error('Called end on pool more than once'))`).
     *
     * This fake USED TO BE IDEMPOTENT, and that is the only reason 339 green tests did
     * not catch the drainAll double-end bug: `drainAll` ended pools that were already
     * mid-drain, real pg would have rejected, `.catch(() => undefined)` swallowed it and
     * `Promise.all` resolved IMMEDIATELY instead of waiting for the real drain — shutdown
     * could exit while a client was still running a query. A forgiving fake made the
     * defect unobservable. Do not relax this back.
     */
    async end(): Promise<void> {
        if (this.ended) throw new Error('Called end on pool more than once');
        this.ended = true;
        if (this.blockEnd) await new Promise<void>((r) => (this.endResolve = r));
    }
    releaseDrain(): void {
        this.endResolve?.();
    }
}

// Module-level, not an instance field: the base constructor calls createPool()
// before subclass field initializers have run.
let created: { name: string; pool: FakePool }[] = [];
let constructionFailsFor: string | null = null;
/** Pools built for this name from now on cannot connect — i.e. the CANDIDATE on a
 *  changed apply is unreachable while the live pool built earlier still works. */
let connectFailsFor: string | null = null;

// Overrides `newPool` (the pg construction seam) and NOT `createPool`, so the
// mandatory pool.on('error') attachment stays production code under test.
class TestPoolManager extends PoolManager {
    protected override newPool(ds: DatasourceConfig): PgPool {
        if (constructionFailsFor === ds.name) throw new Error(`pg rejected config for "${ds.name}"`);
        const pool = new FakePool();
        if (connectFailsFor === ds.name) pool.connectError = new Error(`connect refused for "${ds.name}"`);
        created.push({ name: ds.name, pool });
        return pool as unknown as PgPool;
    }
}

/** True once the manager no longer resolves `name` at all. */
function throwsUnknown(pm: PoolManager, name: string): boolean {
    try {
        pm.getConfig(name);
        return false;
    } catch {
        return true;
    }
}

/** Poll until `cond` holds — for state settled by a fire-and-forget drain. */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setImmediate(r));
    assert.ok(cond(), `timed out waiting for: ${what}`);
}

function ds(name: string, overrides: Partial<DatasourceConfig> = {}): DatasourceConfig {
    return { ...makeConfig().datasources[0], name, ...overrides };
}

function poolFor(name: string): FakePool {
    const hits = created.filter((c) => c.name === name);
    assert.ok(hits.length > 0, `no pool was created for "${name}"`);
    return hits[hits.length - 1].pool;
}

function fresh(names: string[] = ['main']): TestPoolManager {
    created = [];
    constructionFailsFor = null;
    connectFailsFor = null;
    return new TestPoolManager(names.map((n) => ds(n)), silentLogger);
}

/** Let every already-queued microtask AND macrotask settle. Used where the assertion is
 *  that something did NOT happen, so there is no condition waitFor() could poll on. */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

// --- add ------------------------------------------------------------------

test('adds a pool for a new datasource; getConfig returns the new config', async () => {
    const pm = fresh(['main']);
    const report = await pm.applyDatasources([ds('main'), ds('warehouse', { defaultSchema: 'analytics' })]);

    assert.deepEqual(report.added, ['warehouse']);
    assert.deepEqual(report.changed, []);
    assert.deepEqual(report.removed, []);
    assert.deepEqual(report.withheld, []);
    assert.ok(pm.names().includes('warehouse'));
    assert.equal(pm.getConfig('warehouse').defaultSchema, 'analytics');
});

test('a staged datasource is RESOLVABLE but NOT routable until it is published', async () => {
    const pm = fresh(['main']);
    let seenDuringProbe: { routable: boolean; resolvable: boolean } | null = null;

    await pm.applyDatasources([ds('main'), ds('warehouse')], {
        probeAdded: async (name) => {
            // This is the window every request path is protected by: `names()` (which
            // datasourceReady/tools gate on) must NOT yet list it, while getPool/getConfig
            // must resolve it so the posture probe can route THROUGH QueryService to it.
            seenDuringProbe = {
                routable: pm.names().includes(name),
                resolvable: pm.getConfig(name).name === name && Boolean(pm.getPool(name)),
            };
        },
    });

    assert.deepEqual(seenDuringProbe, { routable: false, resolvable: true });
    assert.ok(pm.names().includes('warehouse'), 'published after the probe returned');
});

test('SECURITY: a probe failure withholds the added datasource — never published, pool ended', async () => {
    const pm = fresh(['main']);
    const report = await pm.applyDatasources([ds('main'), ds('warehouse')], {
        probeAdded: async () => {
            throw new Error('posture probe failed');
        },
    });

    assert.deepEqual(report.added, []);
    assert.equal(report.withheld.length, 1);
    assert.equal(report.withheld[0].name, 'warehouse');
    assert.match(report.withheld[0].reason, /posture probe failed/);
    assert.equal(pm.names().includes('warehouse'), false);
    assert.equal(poolFor('warehouse').ended, true, 'the withheld pool must not be leaked');
    // Fully retracted: not resolvable either, so nothing can reach it by any path.
    assert.throws(() => pm.getConfig('warehouse'), /Unknown datasource/);
});

test('one datasource failing does not prevent a sibling in the same apply from publishing', async () => {
    const pm = fresh(['main']);
    const report = await pm.applyDatasources([ds('main'), ds('bad'), ds('good')], {
        probeAdded: async (name) => {
            if (name === 'bad') throw new Error('unreachable');
        },
    });

    assert.deepEqual(report.added, ['good']);
    assert.deepEqual(report.withheld.map((w) => w.name), ['bad']);
    assert.ok(pm.names().includes('good'));
    assert.equal(pm.names().includes('bad'), false);
});

test('pool CONSTRUCTION throwing marks that datasource withheld and does not abort the apply', async () => {
    const pm = fresh(['main']);
    constructionFailsFor = 'broken';

    const report = await pm.applyDatasources([ds('main'), ds('broken'), ds('fine')]);

    assert.deepEqual(report.added, ['fine']);
    assert.equal(report.withheld.length, 1);
    assert.equal(report.withheld[0].name, 'broken');
    assert.match(report.withheld[0].reason, /pg rejected config/);
    assert.ok(pm.names().includes('fine'), 'the apply continued past the failure');
});

// --- change ---------------------------------------------------------------

test('replaces the pool when config changes and ends the previous one', async () => {
    const pm = fresh(['main']);
    const original = poolFor('main');

    const report = await pm.applyDatasources([ds('main', { host: 'newhost.internal' })]);

    assert.deepEqual(report.changed, ['main']);
    assert.equal(pm.getConfig('main').host, 'newhost.internal');
    assert.notEqual(pm.getPool('main'), original as unknown as PgPool, 'a new pool must be in the routable slot');
    assert.equal(original.ended, true, 'the old pool must be drained');
});

test('SECURITY: a changed datasource is probed too — the swap is never silent', async () => {
    const pm = fresh(['main']);
    const probed: string[] = [];

    await pm.applyDatasources([ds('main', { password: 'rotated' })], {
        probeChanged: async (name) => void probed.push(name),
    });

    // A credential swap can move a datasource from a read-only role to a write-capable
    // one; without this probe that transition would produce no log line at all.
    assert.deepEqual(probed, ['main']);
});

test('a post-swap posture failure reports postureUnverified, NOT withheld — the datasource is serving', async () => {
    const pm = fresh(['main']);

    const report = await pm.applyDatasources([ds('main', { password: 'rotated' })], {
        probeChanged: async () => {
            throw new Error('catalog unreadable');
        },
    });

    // `withheld` must stay readable as "not available". On the changed path the swap has
    // already happened and ping — the actual gate — passed, so the datasource IS serving.
    // Reporting it as withheld would tell an operator the opposite of the truth.
    assert.deepEqual(report.withheld, []);
    assert.equal(report.postureUnverified.length, 1);
    assert.equal(report.postureUnverified[0].name, 'main');
    assert.match(report.postureUnverified[0].reason, /catalog unreadable/);
    assert.deepEqual(report.changed, ['main']);
    assert.ok(pm.names().includes('main'), 'still routable');
});

test('SECURITY: a pre-swap PING failure leaves the previous config serving and reports retainedPrevious, not withheld', async () => {
    const pm = fresh(['main']);
    const live = pm.getPool('main');
    connectFailsFor = 'main'; // the candidate is unreachable; the live pool still works

    // A policy-only TIGHTENING (revoking write) during a transient network blip. The gate
    // is a network SELECT 1, so the new pool cannot be verified and the swap is refused —
    // meaning the LOOSER previous config keeps serving. `withheld` reads as "NOT SERVING",
    // so reporting this there tells an operator the exact opposite of what is true, and
    // hides that a security tightening did not land.
    const report = await pm.applyDatasources([ds('main', { writable: false })]);

    assert.deepEqual(report.withheld, [], 'withheld must stay readable as "not available"');
    assert.deepEqual(report.changed, [], 'nothing was swapped, so nothing changed');
    assert.equal(report.retainedPrevious.length, 1);
    assert.equal(report.retainedPrevious[0].name, 'main');
    assert.match(report.retainedPrevious[0].reason, /connect refused/);

    // Still serving — on the PREVIOUS config. Both halves matter: available, but stale.
    assert.ok(pm.names().includes('main'), 'still routable');
    assert.equal(pm.getPool('main'), live, 'the live pool object is untouched');
    assert.equal(pm.getConfig('main').writable, true, 'the tightening did NOT apply');
    assert.equal(poolFor('main').ended, true, 'the unusable candidate must not be leaked');
});

test('SECURITY: candidate CONSTRUCTION failing also reports retainedPrevious — the live pool keeps serving', async () => {
    const pm = fresh(['main']);
    const live = pm.getPool('main');
    constructionFailsFor = 'main';

    const report = await pm.applyDatasources([ds('main', { deniedTables: ['public.secrets'] })]);

    // Same availability truth as the ping path: nothing was un-published, so this is not
    // `withheld`. The two bail-outs must agree, or one of them lies in the reload log.
    assert.deepEqual(report.withheld, []);
    assert.deepEqual(report.changed, []);
    assert.deepEqual(report.retainedPrevious.map((w) => w.name), ['main']);
    assert.match(report.retainedPrevious[0].reason, /pg rejected config/);
    assert.equal(pm.getPool('main'), live);
    assert.deepEqual(pm.getConfig('main').deniedTables, [], 'the denylist entry did NOT apply');
});

test('a retainedPrevious datasource is RETRIED on the next apply, not silently dropped', async () => {
    const pm = fresh(['main']);
    connectFailsFor = 'main';
    await pm.applyDatasources([ds('main', { writable: false })]);

    // The bail-out deliberately leaves the OLD config in `configs`, so the deep-compare
    // still sees a difference next time round. That is what makes a failed change a
    // retry rather than a permanent silent divergence.
    connectFailsFor = null;
    const report = await pm.applyDatasources([ds('main', { writable: false })]);

    assert.deepEqual(report.changed, ['main']);
    assert.deepEqual(report.retainedPrevious, []);
    assert.equal(pm.getConfig('main').writable, false, 'the tightening applied on the retry');
});

test('leaves an unchanged datasource pool object IDENTICAL (no needless churn)', async () => {
    const pm = fresh(['main']);
    const original = pm.getPool('main');

    const report = await pm.applyDatasources([ds('main')]);

    assert.deepEqual(report.changed, []);
    assert.equal(pm.getPool('main'), original, 'same pool object — nothing was rebuilt');
    assert.equal((original as unknown as FakePool).ended, false);
});

// --- remove ---------------------------------------------------------------

test('removed datasource stops routing immediately and drains', async () => {
    const pm = fresh(['main', 'warehouse']);
    const removed = poolFor('warehouse');

    const report = await pm.applyDatasources([ds('main')]);

    assert.deepEqual(report.removed, ['warehouse']);
    assert.equal(pm.names().includes('warehouse'), false);
    assert.equal(removed.ended, true);
});

test('a removed datasource stays RESOLVABLE through its drain window (no spurious 500)', async () => {
    const pm = fresh(['main', 'warehouse']);
    const removed = poolFor('warehouse');
    removed.blockEnd = true; // hold the drain open

    const applying = pm.applyDatasources([ds('main')]);
    await new Promise((r) => setImmediate(r));

    // A request that already passed datasourceReady() (which reads names()) can still
    // reach getConfig()/getPool(). Those throw a PLAIN Error, which statusOf() maps to
    // 500 — so during the drain window the entry must still resolve, or a perfectly
    // valid in-flight request surfaces a server error.
    assert.equal(pm.names().includes('warehouse'), false, 'new requests get a clean 400');
    assert.equal(pm.getConfig('warehouse').name, 'warehouse', 'in-flight request still resolves');
    assert.ok(pm.getPool('warehouse'));

    // The apply itself does NOT block on the drain — a long in-flight query must not
    // stall a reload — so it has already resolved while the pool is still draining.
    await applying;
    assert.equal(pm.getConfig('warehouse').name, 'warehouse', 'still resolvable after apply returned');

    removed.releaseDrain();
    await waitFor(() => !pm.names().includes('warehouse') && throwsUnknown(pm, 'warehouse'), 'drain to retire the entry');
});

test('SECURITY: re-ADDING a name while its old pool is still draining must not retire the NEW live entry', async () => {
    const pm = fresh(['main', 'warehouse']);
    const oldPool = poolFor('warehouse');
    oldPool.blockEnd = true; // pool.end() blocks on a checked-out client

    await pm.applyDatasources([ds('main')]); // remove — drain starts and hangs
    assert.equal(pm.names().includes('warehouse'), false);

    // The operator puts it straight back (fixed a typo, re-added the file). The drain of
    // the OLD pool has still not resolved.
    const report = await pm.applyDatasources([ds('main'), ds('warehouse', { defaultSchema: 'analytics' })]);
    assert.deepEqual(report.added, ['warehouse']);
    const newPool = poolFor('warehouse');
    assert.notEqual(newPool, oldPool, 'a genuinely new pool was published under the same name');

    oldPool.releaseDrain();
    await settle();

    // The old drain's cleanup is keyed on the NAME, and the name now belongs to someone
    // else. Deleting here would leave `warehouse` routable-but-NOT-resolvable — the exact
    // inverse of the DRAINING state, and an invariant violation no request path guards
    // against: /query 500s, and health.route.ts loops poolSize() over names() with no
    // per-name catch, so the whole unauthenticated /health endpoint 500s with it.
    assert.ok(pm.names().includes('warehouse'), 'still routable');
    assert.equal(pm.getConfig('warehouse').defaultSchema, 'analytics', 'the NEW entry must still resolve');
    assert.equal(pm.getPool('warehouse'), newPool as unknown as PgPool);
    assert.doesNotThrow(() => pm.poolSize('warehouse'), 'health.route.ts must not blow up');

    // And the new pool must still be OWNED: dropped from `pools` it would be in neither
    // map nor `draining`, so drainAll() would miss it and it would leak on shutdown.
    await pm.drainAll();
    assert.equal(newPool.ended, true, 'the re-added pool must still be drainable');
});

// --- invariants -----------------------------------------------------------

test('drainAll AWAITS an in-flight drain instead of double-ending it', async () => {
    const pm = fresh(['main', 'warehouse']);
    const removed = poolFor('warehouse');
    removed.blockEnd = true;

    await pm.applyDatasources([ds('main')]); // warehouse is now mid-drain, blocked

    // A removed pool is in BOTH `pools` (it stays resolvable through the drain window)
    // and `draining`. Ending it a second time makes pg reject with "Called end on pool
    // more than once"; with that rejection swallowed, Promise.all resolves IMMEDIATELY
    // for that pool — so shutdown could process.exit(0) while a client is still running
    // a query. drainAll must join the in-flight drain, not race past it.
    let settled = false;
    const all = pm.drainAll().then(() => void (settled = true));
    await settle();
    assert.equal(settled, false, 'drainAll resolved while a pool was still draining');

    removed.releaseDrain();
    await all;
    assert.equal(settled, true);
    assert.equal(removed.ended, true);
});

test('drainAll covers a CHANGED swap old pool, which is draining but no longer resolvable', async () => {
    const pm = fresh(['main']);
    const superseded = poolFor('main');
    superseded.blockEnd = true;

    await pm.applyDatasources([ds('main', { host: 'newhost.internal' })]);

    // The superseded pool is in `draining` only — the name already belongs to the new
    // pool — so this is the one case where `pools` alone is not enough.
    let settled = false;
    const all = pm.drainAll().then(() => void (settled = true));
    await settle();
    assert.equal(settled, false, 'drainAll must wait for a superseded pool too');

    superseded.releaseDrain();
    await all;
    assert.equal(poolFor('main').ended, true, 'the live pool was drained as well');
});

test('every newly created pool gets the mandatory pool.on("error") handler', async () => {
    const pm = fresh(['main']);
    await pm.applyDatasources([ds('main', { host: 'other' }), ds('warehouse')]);

    // Without a listener, an idle backend dying emits an unhandled error and Node
    // kills the process. Every pool this manager creates must carry one.
    for (const { name, pool } of created) {
        assert.equal(pool.errorHandlers, 1, `pool for "${name}" is missing its error handler`);
    }
});

test('drainAll still ends every pool after an apply', async () => {
    const pm = fresh(['main']);
    await pm.applyDatasources([ds('main'), ds('warehouse')]);
    await pm.drainAll();

    for (const { name, pool } of created) {
        assert.equal(pool.ended, true, `pool for "${name}" was not drained`);
    }
});
