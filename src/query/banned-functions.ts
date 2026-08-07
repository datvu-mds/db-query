/**
 * banned-functions — the SINGLE source of truth for side-effecting / host-access
 * function names that are rejected in both read and write modes.
 *
 * Two consumers read this list and must never drift:
 *   - statement-guard.ts scans SQL TEXT (via stripToCode) → BANNED_CALL_PATTERNS.
 *   - relation-guard.ts scans the PARSE TREE's decoded function names → bannedFunctionName().
 *
 * The text scan stays as belt-and-braces for SQL the parser accepts but shapes
 * differently; the parser scan closes the `U&"\0070g_read_file"` unicode-escape gap
 * a lexer cannot decode. Both are defense-in-depth — the non-superuser DB role is
 * the durable fix (see docs/runbooks/agent-ro-pg-role.md).
 */

/** Whole-identifier name fragments (regex source, case-insensitive). Grouped by
 *  danger class; `\\w+` tails cover the families (pg_ls_dir/waldir/…, dblink_exec, …). */
export const BANNED_FUNCTION_SOURCES = [
    // File / dir access
    'pg_read_file',
    'pg_read_binary_file',
    'pg_stat_file',
    'pg_ls_\\w+',
    // Large-object server files
    'lo_export',
    'lo_import',
    // Cross-DB / RCE
    'dblink\\w*',
    // Config / signal / log
    'pg_reload_conf',
    'pg_terminate_backend',
    'pg_cancel_backend',
    'pg_rotate_logfile',
    // WAL / CDC / replication
    'pg_logical_emit_message',
    'pg_create_logical_replication_slot',
    'pg_create_physical_replication_slot',
    'pg_drop_replication_slot',
    'pg_replication_slot_advance',
    'pg_logical_slot_get_changes',
    'pg_logical_slot_peek_changes',
    // Observability tamper
    'pg_stat_reset\\w*',
] as const;

/** Text-scan shape used by statement-guard: `<name>` + optional space + `(`.
 *  Capture group 1 is the matched name (so callers can name it in the error). The
 *  leading `\b` also matches after a schema qualifier (`pg_catalog.pg_read_file(`). */
export const BANNED_CALL_PATTERNS: RegExp[] = BANNED_FUNCTION_SOURCES.map((s) => new RegExp(`\\b(${s})\\s*\\(`, 'i'));

/** Name-only match used by the parser scan (identifier already decoded by libpg-query).
 *  Returns the offending name (for the error message) or null. Anchored so a family
 *  pattern like `pg_ls_\w+` matches the WHOLE name, not a substring. */
export function bannedFunctionName(name: string): string | null {
    return BANNED_FUNCTION_SOURCES.some((s) => new RegExp(`^${s}$`, 'i').test(name)) ? name : null;
}
