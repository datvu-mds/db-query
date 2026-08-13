/**
 * HealthChecker — caps how often the unauthenticated /health endpoint touches the
 * database. Without this, a flood of health probes would each check out a pool
 * connection (there are only `poolMax`), starving real queries and hammering the DB.
 *
 * Result is cached per datasource for `ttlMs`; concurrent misses for the same
 * datasource share ONE in-flight ping. Net effect: at most one `SELECT 1` per
 * datasource per TTL window regardless of probe rate — the one documented exception
 * being `invalidate()` (see below), which a config reload calls for datasources whose
 * pool was swapped or removed.
 */
import type { QueryDriver } from '../driver/query-driver.js';

interface Cached {
    ok: boolean;
    atMs: number;
}

export class HealthChecker {
    private readonly cache = new Map<string, Cached>();
    private readonly inflight = new Map<string, Promise<boolean>>();

    constructor(
        private readonly driver: QueryDriver,
        private readonly ttlMs = 5000,
    ) {}

    async check(name: string): Promise<boolean> {
        const cached = this.cache.get(name);
        if (cached && Date.now() - cached.atMs < this.ttlMs) return cached.ok;

        const pending = this.inflight.get(name);
        if (pending) return pending;

        // The promise object doubles as this ping's identity token: `settle` publishes its
        // verdict only while this exact promise is still the registered in-flight ping.
        const started: Promise<boolean> = this.driver.ping(name).then(
            () => this.settle(name, started, true),
            () => this.settle(name, started, false),
        );
        this.inflight.set(name, started);
        return started;
    }

    /**
     * Drop the cached verdict for one datasource so the next `check()` re-pings.
     *
     * Called by a config reload for every CHANGED and REMOVED datasource. The checker holds
     * only the driver, so it follows a pool swap on its own — but the cache does not: a changed
     * datasource would keep serving its PRE-SWAP verdict for up to a full TTL window, i.e.
     * `/health` reporting an answer about a pool that no longer exists.
     *
     * In-flight pings are dropped too, and that is not optional. A ping issued against the old
     * pool still runs `cache.set` when it settles, so even a `check()`-free reload would let it
     * re-seed the exact stale verdict this method just deleted — hence the identity guard in
     * `settle`, which is needed whether or not we clear `inflight`. Given the guard exists, also
     * unregistering the in-flight ping is strictly better: a probe arriving after the swap starts
     * a fresh ping against the NEW pool instead of being handed the old pool's answer. The cost is
     * one extra ping in the narrow overlap window, and reloads are rare.
     */
    invalidate(name: string): void {
        this.cache.delete(name);
        this.inflight.delete(name);
    }

    /** Record a ping's verdict — unless it has been orphaned by `invalidate()` (or superseded by
     *  a later ping), in which case it describes a pool we no longer serve and is discarded. The
     *  identity check is also what stops an orphan from deleting a NEWER in-flight entry. */
    private settle(name: string, ping: Promise<boolean>, ok: boolean): boolean {
        if (this.inflight.get(name) === ping) {
            this.cache.set(name, { ok, atMs: Date.now() });
            this.inflight.delete(name);
        }
        return ok;
    }
}
