/**
 * PoolManager — owns one `pg.Pool` per logical datasource.
 *
 * One pool per datasource (NOT per tenant): schema-per-account means many tenant
 * schemas, and a pool each would exhaust Postgres `max_connections`. Tenant schema
 * is applied per-query (SET LOCAL search_path in QueryService), so a single pooled
 * connection safely serves different tenants across successive requests.
 *
 * ROUTABLE vs RESOLVABLE (Design Decision 11). A datasource has two independent
 * properties here, and reload depends on being able to set them separately:
 *
 *   routable   — `names()` lists it, so callers may reach it
 *   resolvable — `getPool()`/`getConfig()` answer for it
 *
 * Steady state they are the same set. During a reload they diverge in both
 * directions, and each direction closes a specific hole:
 *
 *   STAGED   (resolvable, not routable) — a newly added datasource that has been
 *     built but not yet probed. The posture probe runs THROUGH QueryService →
 *     driver.connect() → getPool(), so it can only reach a pool that resolves; but
 *     publishing before the probe would serve callers an unprobed datasource. This
 *     is safe ONLY because every request path gates on `names()` before resolving:
 *     `route-helpers.ts` datasourceReady() (covering /query and all /introspect/*),
 *     `mcp/tools.ts` (every tool), `health.route.ts`, `datasources.route.ts`.
 *     Verify that invariant still holds before changing any of this.
 *
 *   DRAINING (resolvable, not routable) — a removed datasource whose `pool.end()`
 *     has not resolved. `getPool`/`getConfig` throw a PLAIN Error, which statusOf()
 *     maps to 500, and a request that already passed datasourceReady() can reach
 *     getConfig() afterwards. Dropping the entry the instant it is unrouted would
 *     turn that perfectly valid in-flight request into a spurious server error.
 */
import pg from 'pg';
import type { Pool as PgPool } from 'pg';
import type { Logger } from 'pino';
import { isDeepStrictEqual } from 'node:util';
import type { DatasourceConfig } from '../config/config.schema.js';

const { Pool } = pg;

export interface ApplyReport {
    added: string[];
    changed: string[];
    removed: string[];
    /**
     * NOT SERVING. Built but never published — construction, ping or the pre-publish
     * probe failed. Never fatal on reload.
     *
     * This field means exactly one thing, and that is deliberate: the reload security
     * log reports it to an operator, and "withheld" has to be readable as "this
     * datasource is not available". A serving-but-imperfect datasource goes in
     * `postureUnverified` instead — see below.
     */
    withheld: { name: string; reason: string }[];
    /**
     * SERVING, but its posture could not be established. Only reachable on the CHANGED
     * path, where the posture probe runs AFTER the swap (Design Decision 11) — so a
     * probe failure there cannot un-publish anything: `ping`, the actual gate, already
     * passed and the new pool is live.
     *
     * Kept separate from `withheld` because the two would otherwise be indistinguishable
     * in the log while meaning opposite things about availability. Reuses the posture
     * vocabulary: this is the reload-time equivalent of `read-only posture UNVERIFIED`.
     */
    postureUnverified: { name: string; reason: string }[];
    /**
     * SERVING, on the PREVIOUS config. Only reachable on the CHANGED path: the candidate
     * pool could not be built, or failed the pre-swap ping, so the swap never happened
     * and the live pool kept serving untouched.
     *
     * Split from `withheld` for the same reason `postureUnverified` was — it is the third
     * distinct thing the two of them would otherwise be flattened into, and this one is
     * security-relevant. Change detection is a full deep-compare while the gate is a
     * network `SELECT 1`, so a POLICY-ONLY tightening (a new `deniedTables` entry,
     * revoking `writable`) can fail to apply because of a transient network blip. The
     * failure direction is "the looser previous policy stays live" — and an operator
     * reading `withheld` ("not available") would conclude the opposite of both halves:
     * that it is down, and that nothing is serving the old rules.
     *
     * NOT a permanent divergence: the bail-outs deliberately leave the OLD config in
     * `configs`, so the next apply's deep-compare still sees the difference and RETRIES
     * the change. Writing the new config in on the failure path would make the retry
     * disappear and strand the datasource on the old pool forever — do not "fix" it that
     * way.
     */
    retainedPrevious: { name: string; reason: string }[];
}

/**
 * Probe callbacks invoked at the one moment each diff path can still act on the
 * result. Two hooks rather than one because the paths are deliberately asymmetric
 * (Design Decision 11) and collapsing them would hide that.
 */
export interface ApplyHooks {
    /** ADDED: after staging + ping, BEFORE publishing. Throwing withholds it. */
    probeAdded?(name: string): Promise<void>;
    /** CHANGED: after the swap. Throwing is recorded, never fatal — see applyDatasources. */
    probeChanged?(name: string): Promise<void>;
}

export class PoolManager {
    /** Resolution maps: routable ∪ staged ∪ draining. Read by getPool/getConfig. */
    private readonly pools = new Map<string, PgPool>();
    private readonly configs = new Map<string, DatasourceConfig>();
    /** The subset that `names()` exposes — i.e. that callers may actually reach. */
    private readonly routable = new Set<string>();
    /** Pools awaiting end(), each mapped to its IN-FLIGHT drain promise. Not name-keyed:
     *  on a CHANGED swap the name already belongs to the new pool, and the old one only
     *  needs draining, not resolving. Holding the promise (rather than just the pool) is
     *  what lets drain() be idempotent and drainAll() JOIN a drain already running
     *  instead of calling end() on the same pool twice — see both. */
    private readonly draining = new Map<PgPool, Promise<void>>();

    constructor(
        datasources: DatasourceConfig[],
        private readonly logger: Logger,
    ) {
        for (const ds of datasources) {
            this.configs.set(ds.name, ds);
            this.pools.set(ds.name, this.createPool(ds));
            this.routable.add(ds.name);
        }
    }

    /**
     * Build a pool AND attach the mandatory error handler. Every pool this class
     * hands out goes through here, so reload cannot introduce one without a handler.
     *
     * Deliberately split from `newPool()`: tests substitute the pg.Pool itself by
     * overriding `newPool`, which leaves THIS function — the part that attaches the
     * handler — as production code under test. Overriding the whole of `createPool`
     * would make the handler assertion test the double instead of the real thing.
     */
    private createPool(ds: DatasourceConfig): PgPool {
        const pool = this.newPool(ds);

        // MANDATORY resilience handler. An idle backend can die (network blip /
        // server restart) and emit an error on the pool; without a listener Node
        // treats it as unhandled and crashes the process. We log + discard — pg
        // removes the dead client and replaces it on the next checkout.
        pool.on('error', (err) => {
            this.logger.error({ datasource: ds.name, err: err.message }, 'idle pg client error (discarded)');
        });

        return pool;
    }

    /** The `pg` construction seam — overridden in tests to drive the full diff state
     *  machine with no live Postgres. */
    protected newPool(ds: DatasourceConfig): PgPool {
        return new Pool({
            host: ds.host,
            port: ds.port,
            user: ds.user,
            password: ds.password,
            database: ds.database,
            // rejectUnauthorized:false matches a typical TypeORM config (managed PG w/ self-signed chain).
            ssl: ds.ssl ? { rejectUnauthorized: false } : undefined,
            max: ds.poolMax,
            idleTimeoutMillis: ds.idleTimeoutMs,
            connectionTimeoutMillis: ds.connectionTimeoutMs,
            maxUses: ds.maxUses,
            allowExitOnIdle: false, // keep pools warm for a long-running server
        });
    }

    getPool(name: string): PgPool {
        const pool = this.pools.get(name);
        if (!pool) throw new Error(`Unknown datasource "${name}"`);
        return pool;
    }

    getConfig(name: string): DatasourceConfig {
        const cfg = this.configs.get(name);
        if (!cfg) throw new Error(`Unknown datasource "${name}"`);
        return cfg;
    }

    /** The ROUTABLE set — what callers may reach. Deliberately excludes staged and
     *  draining entries; see the class header. */
    names(): string[] {
        return [...this.routable];
    }

    poolSize(name: string): number {
        return this.getPool(name).totalCount;
    }

    /** Fail-fast health probe — one round-trip per datasource. Throws on failure. */
    async ping(name: string): Promise<void> {
        await this.pingPool(this.getPool(name));
    }

    /** Ping a pool OBJECT rather than a name. The CHANGED path needs this: the
     *  candidate cannot be resolved by name (the live entry still owns it) and must
     *  be proven reachable BEFORE it is swapped in. */
    private async pingPool(pool: PgPool): Promise<void> {
        const client = await pool.connect();
        try {
            await client.query('SELECT 1');
        } finally {
            client.release();
        }
    }

    /**
     * Diff the live datasources against `next` and apply the difference in place.
     *
     * In place, not by rebuilding Services: routes and MCP tools capture the Services
     * reference at registration and never re-read it, so a replacement instance would
     * be invisible to every consumer.
     *
     * Failure is per-datasource, never global — reload must not take down a running
     * server because one new credential is wrong. What that degrades to depends on the
     * path, and the report says which: a NEW datasource that cannot be built or probed is
     * `withheld` and simply does not appear; a CHANGED one keeps serving its previous
     * config and is `retainedPrevious`. Those are opposite statements about availability,
     * so they are never merged — see ApplyReport.
     */
    async applyDatasources(next: DatasourceConfig[], hooks: ApplyHooks = {}): Promise<ApplyReport> {
        const report: ApplyReport = {
            added: [],
            changed: [],
            removed: [],
            withheld: [],
            postureUnverified: [],
            retainedPrevious: [],
        };
        const nextByName = new Map(next.map((ds) => [ds.name, ds]));

        for (const ds of next) {
            const live = this.routable.has(ds.name) ? this.configs.get(ds.name) : undefined;
            if (!live) {
                await this.addDatasource(ds, hooks, report);
            } else if (!isDeepStrictEqual(live, ds)) {
                // ANY field difference counts as changed, not just connection fields.
                // Deliberately conservative: a credential change is the security case
                // (a different role can have different write grants), and distinguishing
                // "pool-affecting" from "policy-only" edits would create two code paths
                // where one of them silently skips the probe.
                await this.changeDatasource(ds, hooks, report);
            }
        }

        for (const name of [...this.routable]) {
            if (!nextByName.has(name)) this.removeDatasource(name, report);
        }

        return report;
    }

    private async addDatasource(ds: DatasourceConfig, hooks: ApplyHooks, report: ApplyReport): Promise<void> {
        let pool: PgPool;
        try {
            // `pg` can reject a config outright (bad port, malformed connection option).
            // Caught here so one unbuildable datasource cannot abort the whole reload.
            pool = this.createPool(ds);
        } catch (err) {
            report.withheld.push({ name: ds.name, reason: errMessage(err) });
            return;
        }

        // STAGE: resolvable so the probe can route to it, absent from names() so no
        // caller can reach it while it is unproven.
        this.pools.set(ds.name, pool);
        this.configs.set(ds.name, ds);

        try {
            await this.ping(ds.name);
            await hooks.probeAdded?.(ds.name);
        } catch (err) {
            // Withheld, NOT fatal. Boot exits 1 here because nothing is serving yet;
            // on reload something is, and it must keep serving.
            this.pools.delete(ds.name);
            this.configs.delete(ds.name);
            await pool.end().catch(() => undefined);
            report.withheld.push({ name: ds.name, reason: errMessage(err) });
            return;
        }

        this.routable.add(ds.name); // PUBLISH
        report.added.push(ds.name);
    }

    private async changeDatasource(ds: DatasourceConfig, hooks: ApplyHooks, report: ApplyReport): Promise<void> {
        let candidate: PgPool;
        try {
            candidate = this.createPool(ds);
        } catch (err) {
            // NOT `withheld` — nothing was un-published. The live pool is untouched and
            // keeps serving, on its PREVIOUS config. See ApplyReport.retainedPrevious:
            // "not serving" and "serving the old rules" are opposite operator actions.
            report.retainedPrevious.push({ name: ds.name, reason: errMessage(err) });
            return;
        }

        try {
            // Ping the candidate OBJECT before the swap: this is the gate. The name
            // still resolves to the live pool, so this cannot go through ping(name).
            await this.pingPool(candidate);
        } catch (err) {
            await candidate.end().catch(() => undefined);
            // Same as above: the swap did not happen, so the previous config is still
            // live. This is the case that matters most — a policy-only TIGHTENING fails
            // to apply because of a network blip, and the looser rules stay in force.
            report.retainedPrevious.push({ name: ds.name, reason: errMessage(err) });
            return;
        }

        const previous = this.pools.get(ds.name);
        this.pools.set(ds.name, candidate);
        this.configs.set(ds.name, ds);
        report.changed.push(ds.name);

        // Posture AFTER the swap, and never a gate. Posture only ever observes — every
        // write-capable datasource reports WEAK, so no publish decision has ever keyed
        // on it, at boot or here. Holding the swap for it would stall the datasource
        // behind a check that cannot change the outcome. A probe error is recorded and
        // the swap stands, because ping — the actual gate — already succeeded.
        try {
            await hooks.probeChanged?.(ds.name);
        } catch (err) {
            // NOT `withheld` — this datasource IS serving. Conflating the two would tell
            // an operator reading the reload log that a live datasource is unavailable.
            report.postureUnverified.push({ name: ds.name, reason: errMessage(err) });
        }

        // Drain the old pool: end() waits for checked-out clients, so queries already
        // running on it finish on their existing connections.
        if (previous) void this.drain(previous);
    }

    private removeDatasource(name: string, report: ApplyReport): void {
        // Unroute FIRST so new requests get a clean 400 from datasourceReady()...
        this.routable.delete(name);
        report.removed.push(name);

        const pool = this.pools.get(name);
        if (!pool) {
            this.configs.delete(name);
            return;
        }

        // ...but keep it RESOLVABLE until the drain completes, so a request that
        // already passed datasourceReady() completes instead of hitting a 500.
        void this.drain(pool).then(() => {
            // IDENTITY GUARD — delete only if this name still points at the pool WE
            // removed. `pool.end()` blocks on checked-out clients, so a reload issued
            // while it is still draining can RE-ADD the same name; addDatasource then
            // writes a new pool at this key and publishes it. A name-keyed delete would
            // retire that NEW live entry, leaving the datasource routable but NOT
            // resolvable — the exact inverse of the DRAINING state this branch exists to
            // create, and the one direction nothing guards against: every request path
            // gates on names(), which would say yes, and then getPool/getConfig throw a
            // plain Error → 500 on /query, and health.route.ts loops poolSize() over
            // names() with no per-name catch, so the whole unauthenticated /health goes
            // with it. The orphaned pool would also leak — absent from both `pools` and
            // `draining`, drainAll() cannot see it — and it all persists until someone
            // sends a reload nobody knows is needed.
            if (this.pools.get(name) !== pool) return;
            this.pools.delete(name);
            this.configs.delete(name);
        });
    }

    /**
     * Track + end a pool, ONCE. Tracked so drainAll() covers pools that are mid-drain.
     *
     * Idempotent per pool object, and that is load-bearing rather than tidiness: `pg`
     * rejects a second end() with "Called end on pool more than once", so a caller that
     * re-ends a draining pool gets an immediately-settled promise instead of the real
     * drain. Returning the in-flight promise makes a duplicate call WAIT for the actual
     * end() rather than race past it.
     */
    private drain(pool: PgPool): Promise<void> {
        const inFlight = this.draining.get(pool);
        if (inFlight) return inFlight;

        // The .finally() callback is a microtask, so the synchronous `set` below always
        // runs first — even if end() were to throw synchronously. Do not fold this back
        // into an async body with the delete in a `finally` block; that ordering is only
        // safe by accident.
        const done = this.endPool(pool).finally(() => this.draining.delete(pool));
        this.draining.set(pool, done);
        return done;
    }

    /** Best-effort end(): a pool that fails to end must not break a reload or a shutdown.
     *  Separate from drain() so the returned promise NEVER rejects — every caller below
     *  awaits it, and one bad pool must not reject the whole drain. */
    private async endPool(pool: PgPool): Promise<void> {
        try {
            await pool.end();
        } catch {
            // swallowed deliberately — see above
        }
    }

    /** Drain every pool on shutdown — routable, staged AND mid-drain. Best-effort. */
    async drainAll(): Promise<void> {
        // De-duplicated by DRAIN PROMISE, not by pool: a pool removed by
        // removeDatasource() is in `pools` (it stays resolvable through its drain window)
        // AND in `draining`, so ending both lists would call end() on it twice. pg
        // rejects the second call, and with that rejection swallowed Promise.all would
        // resolve IMMEDIATELY for that pool instead of waiting for the real drain —
        // letting server.ts process.exit(0) while a client is still running a query.
        // Routing everything through drain() collapses the duplicate onto one promise, so
        // an in-flight drain is AWAITED. `draining` is included because a CHANGED swap's
        // superseded pool is only there — `pools` no longer holds it.
        const drains = new Set<Promise<void>>(this.draining.values());
        for (const pool of this.pools.values()) drains.add(this.drain(pool));
        await Promise.all(drains);
    }
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
