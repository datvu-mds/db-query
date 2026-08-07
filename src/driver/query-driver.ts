/**
 * QueryDriver — the engine-neutral boundary. QueryService talks only to this
 * interface (never to `pg` directly), so a future MySQL/other driver, and the
 * Phase 4 MCP adapter, reuse the orchestration unchanged.
 *
 * The interface is deliberately low-level: `exec` runs ONE SQL command on a
 * checked-out connection. QueryService issues BEGIN / SET LOCAL / COMMIT through
 * `exec`, which is what lets a stubbed driver assert the transaction wrap order.
 */

export interface DriverColumn {
    name: string;
    /** Friendly type name (e.g. "uuid", "int4"); falls back to the OID string. */
    dataType: string;
}

export interface DriverResult {
    fields: DriverColumn[];
    rows: Record<string, unknown>[];
    /** For SELECT: rows returned. For INSERT/UPDATE/DELETE: rows affected. */
    rowCount: number;
    /** pg command tag — SELECT / INSERT / UPDATE / DELETE / BEGIN / SET / COMMIT. */
    command: string;
}

export interface DriverConnection {
    /** Execute a single parameterized statement on this connection. */
    exec(sql: string, params?: unknown[]): Promise<DriverResult>;
    /** Return the connection to the pool. Must be called in a `finally`. Passing a
     *  truthy `err` DESTROYS the connection instead of reusing it — use when the
     *  connection's state is uncertain (e.g. a ROLLBACK itself failed). */
    release(err?: unknown): void;
}

export interface QueryDriver {
    /** Check out a connection from the named datasource's pool. */
    connect(datasource: string): Promise<DriverConnection>;
    /** Health probe for the named datasource. */
    ping(datasource: string): Promise<void>;
}
