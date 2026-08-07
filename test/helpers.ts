/**
 * Shared test helpers: an in-memory config, a stub QueryDriver that records the
 * exact exec() sequence (so we can assert the transaction wrap order), and a
 * capturing AuditLogger. These let the full HTTP/MCP path run with NO live
 * Postgres — integration tests (test/integration/*) cover real-DB behavior.
 */
import pino from 'pino';
import type { RootConfig } from '../src/config/config.schema.js';
import type { QueryDriver, DriverConnection, DriverResult } from '../src/driver/query-driver.js';
import { AuditLogger, type AuditEntry } from '../src/audit/audit-logger.js';

export const silentLogger = pino({ level: 'silent' });

export function makeConfig(overrides: Partial<RootConfig> = {}): RootConfig {
    return {
        port: 3200,
        host: '127.0.0.1',
        logLevel: 'silent',
        maxRowsCeiling: 10000,
        datasources: [
            {
                name: 'main',
                host: 'localhost',
                port: 5432,
                user: 'postgres',
                password: 'postgres',
                database: 'appdb',
                ssl: false,
                defaultSchema: 'public',
                poolMax: 5,
                statementTimeoutMs: 10000,
                idleTimeoutMs: 10000,
                connectionTimeoutMs: 5000,
                maxUses: 7500,
                allowUnsafeStatements: false,
                deniedTables: [],
                // Off in the shared fixture so existing tests exercise the config
                // denylist / caps in isolation; the built-in has its own opt-in tests.
                sensitiveRelationDenylist: false,
            },
        ],
        tokens: [
            { id: 'agent_ro', secret: 'ro-secret', datasources: ['main'], mode: 'read', schemas: ['*'] },
            { id: 'svc_rw', secret: 'rw-secret', datasources: ['main'], mode: 'write', schemas: ['public'] },
        ],
        ...overrides,
    };
}

export function emptyResult(command = ''): DriverResult {
    return { fields: [], rows: [], rowCount: 0, command };
}

const CONTROL = (sql: string): boolean => {
    const h = sql.trim().toUpperCase();
    return h.startsWith('BEGIN') || h.startsWith('SET ') || h === 'COMMIT' || h === 'ROLLBACK' || h === 'DISCARD ALL';
};

/** Programmable QueryDriver stub. `userResult` is returned for the caller's (non-
 *  control) statement; control statements return an empty result. */
export class StubDriver implements QueryDriver {
    calls: { sql: string; params?: unknown[] }[] = [];
    released = 0;
    releaseErrors: unknown[] = [];
    connectCount = 0;
    pingCount = 0;
    connectError: Error | null = null;
    userError: Error | null = null;
    rollbackError: Error | null = null;
    discardError: Error | null = null;
    pingError: Error | null = null;
    userResult: DriverResult = emptyResult('SELECT');

    async connect(): Promise<DriverConnection> {
        this.connectCount++;
        if (this.connectError) throw this.connectError;
        return {
            exec: async (sql: string, params?: unknown[]): Promise<DriverResult> => {
                this.calls.push({ sql, params });
                if (CONTROL(sql)) {
                    const head = sql.trim().toUpperCase();
                    if (this.rollbackError && head === 'ROLLBACK') throw this.rollbackError;
                    if (this.discardError && head === 'DISCARD ALL') throw this.discardError;
                    return emptyResult(head.split(' ')[0]);
                }
                if (this.userError) throw this.userError;
                return this.userResult;
            },
            release: (err?: unknown): void => {
                this.released++;
                this.releaseErrors.push(err);
            },
        };
    }

    async ping(): Promise<void> {
        this.pingCount++;
        if (this.pingError) throw this.pingError;
    }

    /** Ordered SQL of every exec (control + user). */
    sqls(): string[] {
        return this.calls.map((c) => c.sql.trim());
    }

    /** SQL of only the non-control (user) statements. */
    userStatements(): { sql: string; params?: unknown[] }[] {
        return this.calls.filter((c) => !CONTROL(c.sql));
    }
}

/** AuditLogger that records entries in memory instead of writing them. */
export class CapturingAudit extends AuditLogger {
    entries: AuditEntry[] = [];
    constructor() {
        super(silentLogger);
    }
    override logQuery(entry: AuditEntry): void {
        this.entries.push(entry);
    }
}
