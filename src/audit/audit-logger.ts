/**
 * AuditLogger — one structured pino line per query. Records token *id* (never the
 * secret), datasource, schema, sql text, rowCount, elapsedMs and any error. Write
 * queries carry extra fields (write/command/rowsAffected) so the audit stream is
 * filterable for security review.
 *
 * Security note: callers MUST pass values via `params` ($1…) — inlined SQL
 * literals ARE logged (params are not). SQL text is capped at TEXT_LOG_MAX chars
 * to bound log volume and limit how much an accidental literal can leak; we do
 * not attempt secret-pattern redaction (fragile, and params already cover the
 * real vector).
 *
 * `error` is capped identically: Postgres echoes the offending literal into its
 * error messages, so an uncapped error field would reopen the same volume/leak
 * vector the sql cap closes.
 *
 * Truncation always records `sqlLength` (the true pre-truncation length), so a
 * shortened line stays attributable in forensics — otherwise pushing the
 * meaningful clause past the cap would quietly erase it from the audit trail.
 */
import type { Logger } from 'pino';

/** Max characters of free text (sql, error) written to an audit line. */
const TEXT_LOG_MAX = 2000;

export interface AuditEntry {
    tokenId: string;
    datasource: string;
    schema: string;
    sql: string;
    rowCount: number;
    elapsedMs: number;
    error?: string;
    // Write-path fields (Phase 3) — populated only when a write actually ran.
    write?: boolean;
    command?: string;
    rowsAffected?: number;
    /** Set only when `sql` was truncated: the true length of the original statement. */
    sqlLength?: number;
}

/** Keep the head of the text (the identifying part) + how much was dropped. */
function truncate(text: string): string {
    return `${text.slice(0, TEXT_LOG_MAX)}…[+${text.length - TEXT_LOG_MAX} chars]`;
}

export class AuditLogger {
    private readonly log: Logger;

    constructor(parent: Logger) {
        this.log = parent.child({ component: 'audit' });
    }

    logQuery(entry: AuditEntry): void {
        // Build a copy only when something needs capping — the caller's entry object
        // is not ours to mutate, and the common case should stay allocation-free.
        const longSql = entry.sql.length > TEXT_LOG_MAX;
        const longErr = entry.error !== undefined && entry.error.length > TEXT_LOG_MAX;
        let line = entry;
        if (longSql || longErr) {
            line = { ...entry };
            if (longSql) {
                line.sql = truncate(entry.sql);
                line.sqlLength = entry.sql.length; // keeps a truncated line attributable
            }
            if (longErr) line.error = truncate(entry.error!);
        }
        if (line.error) {
            this.log.warn(line, 'query failed');
        } else {
            this.log.info(line, 'query ok');
        }
    }
}
