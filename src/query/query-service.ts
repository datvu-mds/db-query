/**
 * QueryService — orchestrates a single query under all guardrails, and emits the
 * audit line. Engine-neutral: it drives BEGIN / SET LOCAL / COMMIT through the
 * QueryDriver, never touching `pg`. Auditing lives here (not in the routes) so
 * every transport — HTTP /query, introspection, and the MCP adapter — is audited
 * identically.
 *
 * The transaction wrapper is the P0 tenant-isolation invariant, NOT mere overhead:
 * a pooled connection is a long-lived session, so a plain `SET search_path` would
 * leak to the next borrower (cross-tenant read). `SET LOCAL` auto-resets on
 * COMMIT/ROLLBACK, returning the connection to the pool pristine.
 *
 * `SET LOCAL` covers only the settings WE issue, so it is not by itself a clean
 * hand-off: a caller's own plain `SET` survives COMMIT on that pooled connection.
 * DISCARD ALL on the way out is what actually makes the connection pristine.
 *
 * Wrap order (asserted by unit tests with a stubbed driver):
 *   BEGIN [TRANSACTION READ ONLY] → SET LOCAL statement_timeout →
 *   SET LOCAL idle_in_transaction_session_timeout → SET LOCAL search_path →
 *   <caller sql> → COMMIT → DISCARD ALL
 *   (ROLLBACK on any error; release() always in finally)
 */
import type { QueryDriver } from '../driver/query-driver.js';
import type { PoolManager } from '../pool/pool-manager.js';
import type { AuditLogger } from '../audit/audit-logger.js';
import type { QueryResponse } from './query.schema.js';
import { assertSingleStatement } from './single-statement.js';
import { assertStatementAllowed } from './statement-guard.js';
import { assertRelationsAllowed } from './relation-guard.js';
import { BadRequestError, ServiceUnavailableError } from './gateway-errors.js';

/** idle_in_transaction_session_timeout is kept above statement_timeout so a
 *  long-but-progressing query isn't killed for "idling"; it fires only on a truly
 *  stalled open transaction (which would hold a connection + locks). */
const IDLE_TXN_BUFFER_MS = 5000;

export interface RunInput {
    tokenId: string; // for audit; identity is authorized by the caller
    datasource: string;
    schema: string; // effective schema (already defaulted + authorized)
    sql: string;
    params?: unknown[];
    /** Final authorized write decision (write token AND explicit readOnly:false). */
    write: boolean;
    maxRows?: number;
    timeoutMs?: number;
    /** Token schema capabilities (caps.schemas); ['*'] = any non-system schema.
     *  Omitted ⇒ only `schema` itself is allowed (fail-closed). */
    allowedSchemas?: string[];
}

export interface RunResult {
    response: QueryResponse;
    command: string; // pg command tag
}

/**
 * Internal trust marker for the gateway's OWN fixed catalog SQL (introspection, boot
 * posture probe). Deliberately a SECOND POSITIONAL ARGUMENT, never a RunInput field:
 * an HTTP body or MCP args object can be spread into RunInput, but it can never become
 * argument #2. Only in-process callers holding a QueryService can set it — unreachable
 * by construction, not by convention. Never widen it to carry caller-supplied SQL.
 */
export interface InternalTrust {
    internalCatalogQuery: true;
    reason: 'introspection' | 'boot-probe';
}

function clamp(v: number, min: number, max: number): number {
    return Math.min(Math.max(Math.trunc(v), min), max);
}

/** Quote a schema as a Postgres identifier (double-quote, escape embedded quotes).
 *  This is why `search_path` can't be a bound parameter — SET takes an identifier,
 *  not a value — so we quote defensively instead of string-concatenating raw SQL. */
function quoteIdent(ident: string): string {
    if (ident.includes('\0')) throw new BadRequestError('Invalid schema identifier');
    return `"${ident.replace(/"/g, '""')}"`;
}

export class QueryService {
    constructor(
        private readonly driver: QueryDriver,
        private readonly pools: PoolManager,
        private readonly maxRowsCeiling: number,
        private readonly audit: AuditLogger,
    ) {}

    async run(input: RunInput, internal?: InternalTrust): Promise<RunResult> {
        const started = Date.now();

        // Guardrail (always-on, first): reject multi-statement SQL before any DB
        // contact (→ 400). The escape hatch below never relaxes this. Audited too —
        // a `;`-smuggle is a primary attack and must show up in the security stream.
        try {
            assertSingleStatement(input.sql);
        } catch (err) {
            const msg = (err as Error).message;
            this.auditError(input, started, msg);
            throw new BadRequestError(msg);
        }

        const dsCfg = this.pools.getConfig(input.datasource);

        // Defense-in-depth: reject side-effecting statements/functions (COPY,
        // pg_read_file, …) that a read-only txn does NOT stop, before any DB contact.
        // Skipped only when the operator has explicitly opted this datasource out.
        // Blocked attempts are audited so they show up in the security stream.
        if (!dsCfg.allowUnsafeStatements) {
            try {
                assertStatementAllowed(input.sql, { write: input.write });
            } catch (err) {
                this.auditError(input, started, (err as Error).message);
                throw err;
            }
        }

        // Relation guard (third layer, still pre-DB-contact): parse the statement with
        // the real Postgres parser and enforce catalog block + schema caps + denied
        // tables on every referenced relation. Skipped for the gateway's OWN fixed
        // catalog SQL (introspection / boot probe) and for a datasource the operator
        // has explicitly opted out. Rejections (400 or 403) are audited like any other.
        if (!dsCfg.allowUnsafeStatements && !internal?.internalCatalogQuery) {
            try {
                await assertRelationsAllowed(input.sql, {
                    schema: input.schema,
                    allowedSchemas: input.allowedSchemas ?? [input.schema],
                    deniedTables: dsCfg.deniedTables,
                });
            } catch (err) {
                this.auditError(input, started, (err as Error).message);
                throw err; // BadRequestError 400 | ForbiddenError 403
            }
        }

        // Clamps: a request may only LOWER the timeout / row cap, never exceed the
        // per-datasource statement timeout or the absolute row ceiling.
        const stmtMs = clamp(input.timeoutMs ?? dsCfg.statementTimeoutMs, 1, dsCfg.statementTimeoutMs);
        const idleMs = stmtMs + IDLE_TXN_BUFFER_MS;
        const maxRows = clamp(input.maxRows ?? this.maxRowsCeiling, 1, this.maxRowsCeiling);
        const schemaIdent = quoteIdent(input.schema);

        // Acquire — bounded by connectionTimeoutMillis; failure to acquire (DB down
        // or pool saturated) surfaces as 503, not an unbounded wait.
        let conn;
        try {
            conn = await this.driver.connect(input.datasource);
        } catch (err) {
            const msg = `datasource "${input.datasource}" unavailable: ${(err as Error).message}`;
            this.auditError(input, started, msg);
            throw new ServiceUnavailableError(msg);
        }

        // If even ROLLBACK fails the connection's state is uncertain — destroy it
        // on release rather than handing a poisoned connection to the next borrower.
        let releaseErr: unknown;
        try {
            await conn.exec(input.write ? 'BEGIN' : 'BEGIN TRANSACTION READ ONLY');
            // Integer ms literals we fully control; schema is a quoted identifier.
            await conn.exec(`SET LOCAL statement_timeout TO ${stmtMs}`);
            await conn.exec(`SET LOCAL idle_in_transaction_session_timeout TO ${idleMs}`);
            // `pg_temp` is named LAST on purpose: when it is absent from search_path
            // Postgres still searches it, and searches it FIRST — ahead of the tenant
            // schema — for relation names. A temp table left on the pooled connection
            // would then shadow the next borrower's real table. Naming it explicitly
            // demotes it to last place.
            await conn.exec(`SET LOCAL search_path TO ${schemaIdent}, pg_temp`);

            const res = await conn.exec(input.sql, input.params);
            await conn.exec('COMMIT');

            // Truncation without a second query: if more rows came back than the
            // cap, drop the surplus and flag it.
            const truncated = res.rows.length > maxRows;
            const rows = truncated ? res.rows.slice(0, maxRows) : res.rows;

            const response: QueryResponse = {
                columns: res.fields,
                rows,
                rowCount: rows.length,
                truncated,
                elapsedMs: Date.now() - started,
            };
            if (input.write) response.rowsAffected = res.rowCount;

            this.audit.logQuery({
                tokenId: input.tokenId,
                datasource: input.datasource,
                schema: input.schema,
                sql: input.sql,
                rowCount: response.rowCount,
                elapsedMs: response.elapsedMs,
                write: input.write || undefined,
                command: input.write ? res.command : undefined,
                rowsAffected: input.write ? res.rowCount : undefined,
            });

            return { response, command: res.command };
        } catch (err) {
            // ROLLBACK is best-effort — the connection may already be broken. If it
            // also fails, mark the connection for destruction on release.
            await conn.exec('ROLLBACK').catch((rbErr: unknown) => {
                releaseErr = rbErr;
            });
            this.auditError(input, started, (err as Error).message);
            throw err;
        } finally {
            // Scrub caller-set SESSION state before the connection goes back to the
            // pool. `SET LOCAL` only auto-resets the settings WE issue; a caller's
            // plain `SET` inside the txn survives COMMIT and the next borrower
            // inherits it (proven: `SET statement_timeout = 0` disables the timeout
            // guardrail for everyone after them; `SET ROLE` re-identifies them).
            // DISCARD ALL also drops temp tables and prepared statements. It must run
            // OUTSIDE a transaction, which the COMMIT/ROLLBACK above guarantees.
            // Skipped when ROLLBACK already failed — that connection is being
            // destroyed anyway.
            if (!releaseErr) {
                await conn.exec('DISCARD ALL').catch((err: unknown) => {
                    // State is now unknown; destroy rather than hand it on dirty.
                    releaseErr = err;
                });
            }
            // A leaked (never-released) client permanently shrinks the pool → deadlock.
            conn.release(releaseErr);
        }
    }

    private auditError(input: RunInput, started: number, message: string): void {
        this.audit.logQuery({
            tokenId: input.tokenId,
            datasource: input.datasource,
            schema: input.schema,
            sql: input.sql,
            rowCount: 0,
            elapsedMs: Date.now() - started,
            error: message,
            write: input.write || undefined,
        });
    }
}
