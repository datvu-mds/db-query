/**
 * PostgresDriver — the `pg` implementation of QueryDriver. This is the ONLY file
 * (besides pool-manager) that imports `pg`; everything above talks to the
 * QueryDriver interface, keeping the gateway engine-neutral.
 */
import pg from 'pg';
import type { PoolClient, QueryConfig } from 'pg';
import type { PoolManager } from '../pool/pool-manager.js';
import type { DriverConnection, DriverResult, QueryDriver } from './query-driver.js';

/** `queryMode` is supported by pg (>= 8.13) but not yet declared in @types/pg. */
interface ExtendedQueryConfig extends QueryConfig {
    queryMode: 'extended';
}

// Invert pg's builtin type table (name→oid) into oid→friendly-name once at load.
// Unknown OIDs (custom enums, domains) fall back to their numeric OID string.
const OID_TO_NAME = new Map<number, string>(
    Object.entries(pg.types.builtins).map(([name, oid]) => [oid as number, name.toLowerCase()]),
);

function typeName(oid: number): string {
    return OID_TO_NAME.get(oid) ?? String(oid);
}

class PostgresConnection implements DriverConnection {
    constructor(private readonly client: PoolClient) {}

    async exec(sql: string, params?: unknown[]): Promise<DriverResult> {
        // THE structural multi-statement defense. `pg` picks the wire protocol by
        // whether params were supplied: with none it uses the SIMPLE protocol, which
        // happily runs `a; b` from a single call — so any hole in the text-level
        // scanner let a caller smuggle a second statement (notably `COMMIT`, which
        // escapes BEGIN TRANSACTION READ ONLY and hands a read-only token writes).
        // Forcing `queryMode:'extended'` sends Parse/Bind/Execute even with zero
        // params, and the SERVER then rejects multi-statement text. Structural, not
        // heuristic — do not revert to the two-arg form.
        const config: ExtendedQueryConfig = { text: sql, values: params, queryMode: 'extended' };
        const res = await this.client.query(config);
        return {
            fields: (res.fields ?? []).map((f) => ({ name: f.name, dataType: typeName(f.dataTypeID) })),
            rows: (res.rows ?? []) as Record<string, unknown>[],
            rowCount: res.rowCount ?? 0,
            command: res.command ?? '',
        };
    }

    release(err?: unknown): void {
        // pg destroys the client (rather than returning it to the pool) when
        // release is called with a truthy error — prevents reusing a poisoned conn.
        this.client.release(err ? (err instanceof Error ? err : true) : undefined);
    }
}

export class PostgresDriver implements QueryDriver {
    constructor(private readonly pools: PoolManager) {}

    async connect(datasource: string): Promise<DriverConnection> {
        // Bounded by the pool's connectionTimeoutMillis — rejects (→ 503) when the
        // pool is saturated or the DB is unreachable, rather than queueing forever.
        const client = await this.pools.getPool(datasource).connect();
        return new PostgresConnection(client);
    }

    async ping(datasource: string): Promise<void> {
        await this.pools.ping(datasource);
    }
}
