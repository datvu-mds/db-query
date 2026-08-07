/**
 * connection-info-functions — identity / "where am I" functions that reveal WHO the
 * gateway connects as (current_user, session_user, …) and WHICH database/host it
 * connects to (current_database, current_catalog, inet_server_addr, …) WITHOUT
 * referencing any relation the relation-guard would inspect. `run_query` returns row
 * DATA from your tables; it must not answer meta-questions about the connection.
 *
 * Blocking these closes the `SELECT current_user, current_database()` path an agent
 * could otherwise use to read back the datasource's real user/db/host — the exact
 * values `.claude/rules/secrets-nondisclosure.md` forbids disclosing. Introspection
 * (list_schemas / list_tables / describe_table) is the sanctioned way to learn
 * structure and needs none of these.
 *
 * Date/time value functions (now(), current_date, current_timestamp, …) are NOT here:
 * they carry no identity and are common in ordinary WHERE clauses.
 *
 * Two node shapes carry these, both folded into SqlRefs.functions by the walk:
 *   - FuncCall         → current_database(), inet_server_addr(), …   (name via funcname)
 *   - SQLValueFunction → current_user, session_user, current_catalog, …  (keyword, no parens; via op)
 * so ONE denylist below covers both.
 */

/** Connection-identity function names (already decoded + case-folded by libpg-query). */
export const CONNECTION_INFO_FUNCTIONS: readonly string[] = [
    // who
    'current_user',
    'session_user',
    'current_role',
    'user',
    // which database
    'current_database',
    'current_catalog',
    // which schema (schema-per-tenant → the tenant UUID)
    'current_schema',
    'current_schemas',
    // where (server / client address + port)
    'inet_server_addr',
    'inet_server_port',
    'inet_client_addr',
    'inet_client_port',
];

/**
 * SQLValueFunction.op → canonical name. The KEYWORD forms (`current_user`,
 * `session_user`, `current_catalog`, `current_schema`, `user`, `current_role`) parse
 * to SQLValueFunction ops, NOT FuncCall — the walk maps them here so they flow through
 * the SAME denylist. Date/time ops (SVFOP_CURRENT_DATE, …) are intentionally absent.
 */
export const SQL_VALUE_FUNCTION_NAMES: Readonly<Record<string, string>> = {
    SVFOP_CURRENT_ROLE: 'current_role',
    SVFOP_CURRENT_USER: 'current_user',
    SVFOP_USER: 'user',
    SVFOP_SESSION_USER: 'session_user',
    SVFOP_CURRENT_CATALOG: 'current_catalog',
    SVFOP_CURRENT_SCHEMA: 'current_schema',
};

const NAME_SET = new Set(CONNECTION_INFO_FUNCTIONS);

/** Returns the offending name if `name` is a connection-identity function, else null. */
export function connectionInfoFunction(name: string): string | null {
    return NAME_SET.has(name.toLowerCase()) ? name : null;
}

/**
 * GUCs that alias connection identity through a different door: `current_setting`
 * ('session_authorization') returns the session user, ('role') the current role — the
 * same leak as session_user / current_role. (Plain `SHOW` is already rejected upstream;
 * this closes its current_setting() equivalent.)
 */
export const SENSITIVE_SETTINGS: readonly string[] = ['session_authorization', 'role'];
const SETTING_SET = new Set(SENSITIVE_SETTINGS);

/**
 * A current_setting() argument is disallowed when it names a sensitive GUC, OR when it
 * is not a static string literal (null) — fail-closed, since an argument we cannot read
 * at check time is an argument we cannot clear.
 */
export function sensitiveSettingArg(arg: string | null): boolean {
    return arg === null || SETTING_SET.has(arg.toLowerCase());
}
