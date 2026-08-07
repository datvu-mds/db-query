/**
 * HealthChecker — caps how often the unauthenticated /health endpoint touches the
 * database. Without this, a flood of health probes would each check out a pool
 * connection (there are only `poolMax`), starving real queries and hammering the DB.
 *
 * Result is cached per datasource for `ttlMs`; concurrent misses for the same
 * datasource share ONE in-flight ping. Net effect: at most one `SELECT 1` per
 * datasource per TTL window regardless of probe rate.
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

        let pending = this.inflight.get(name);
        if (!pending) {
            pending = this.driver
                .ping(name)
                .then(
                    () => (this.cache.set(name, { ok: true, atMs: Date.now() }), true),
                    () => (this.cache.set(name, { ok: false, atMs: Date.now() }), false),
                )
                .finally(() => this.inflight.delete(name));
            this.inflight.set(name, pending);
        }
        return pending;
    }
}
