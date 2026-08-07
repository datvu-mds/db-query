/**
 * PoolManager — owns one `pg.Pool` per logical datasource.
 *
 * One pool per datasource (NOT per tenant): schema-per-account means many tenant
 * schemas, and a pool each would exhaust Postgres `max_connections`. Tenant schema
 * is applied per-query (SET LOCAL search_path in QueryService), so a single pooled
 * connection safely serves different tenants across successive requests.
 */
import pg from 'pg';
import type { Pool as PgPool } from 'pg';
import type { Logger } from 'pino';
import type { DatasourceConfig } from '../config/config.schema.js';

const { Pool } = pg;

export class PoolManager {
    private readonly pools = new Map<string, PgPool>();
    private readonly configs = new Map<string, DatasourceConfig>();

    constructor(
        datasources: DatasourceConfig[],
        private readonly logger: Logger,
    ) {
        for (const ds of datasources) {
            this.configs.set(ds.name, ds);
            this.pools.set(ds.name, this.createPool(ds));
        }
    }

    private createPool(ds: DatasourceConfig): PgPool {
        const pool = new Pool({
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

        // MANDATORY resilience handler. An idle backend can die (network blip /
        // server restart) and emit an error on the pool; without a listener Node
        // treats it as unhandled and crashes the process. We log + discard — pg
        // removes the dead client and replaces it on the next checkout.
        pool.on('error', (err) => {
            this.logger.error({ datasource: ds.name, err: err.message }, 'idle pg client error (discarded)');
        });

        return pool;
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

    names(): string[] {
        return [...this.pools.keys()];
    }

    poolSize(name: string): number {
        return this.getPool(name).totalCount;
    }

    /** Fail-fast health probe — one round-trip per datasource. Throws on failure. */
    async ping(name: string): Promise<void> {
        const client = await this.getPool(name).connect();
        try {
            await client.query('SELECT 1');
        } finally {
            client.release();
        }
    }

    /** Drain every pool on shutdown. Best-effort — never throws. */
    async drainAll(): Promise<void> {
        await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
    }
}
