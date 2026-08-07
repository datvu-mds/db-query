/**
 * load-config — turn `process.env` into a validated RootConfig.
 *
 * Flow: read comma-separated `DATASOURCES` / `TOKENS` id lists → expand each id
 * into its `DS_<NAME>_*` / `TOKEN_<ID>_*` keys → assemble plain objects →
 * validate with zod (fail-fast). If NO `DS_*` datasource is configured we seed a
 * single `main` from the canonical `DATABASE_*` vars, so the
 * gateway drops into the existing stack with zero new config.
 */
import { rootConfigSchema, type RootConfig } from './config.schema.js';

/** Trimmed env value, or undefined when missing/empty (so zod defaults apply). */
function env(key: string): string | undefined {
    const v = process.env[key];
    if (v === undefined) return undefined;
    const t = v.trim();
    return t === '' ? undefined : t;
}

/** Split a comma-separated env value into a clean list. */
function list(v: string | undefined): string[] {
    if (!v) return [];
    return v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Explicit "true"/"false" → boolean (NOT Boolean("false") which is true). */
function bool(v: string | undefined): boolean | undefined {
    if (v === undefined) return undefined;
    return v.toLowerCase() === 'true';
}

/** Fail-CLOSED boolean for secure-by-default toggles: undefined ⇒ undefined (zod default
 *  true applies); an explicit off value ("false"/"0"/"no"/"off") ⇒ false; ANY other value
 *  ⇒ true. A typo like "1" or "enabled" keeps the safety net ON instead of silently
 *  disabling it (the asymmetry that made a plain `bool()` fail-open here). */
function boolSecureDefault(v: string | undefined): boolean | undefined {
    if (v === undefined) return undefined;
    return !['false', '0', 'no', 'off'].includes(v.toLowerCase());
}

function buildDatasource(name: string): Record<string, unknown> {
    const p = `DS_${name.toUpperCase()}_`;
    return {
        name,
        host: env(`${p}HOST`),
        port: env(`${p}PORT`),
        user: env(`${p}USER`),
        password: env(`${p}PASSWORD`) ?? '',
        database: env(`${p}DATABASE`),
        ssl: bool(env(`${p}SSL`)),
        defaultSchema: env(`${p}DEFAULT_SCHEMA`),
        poolMax: env(`${p}POOL_MAX`),
        statementTimeoutMs: env(`${p}STATEMENT_TIMEOUT_MS`),
        idleTimeoutMs: env(`${p}IDLE_TIMEOUT_MS`),
        connectionTimeoutMs: env(`${p}CONNECTION_TIMEOUT_MS`),
        maxUses: env(`${p}MAX_USES`),
        allowUnsafeStatements: bool(env(`${p}ALLOW_UNSAFE_STATEMENTS`)),
        deniedTables: list(env(`${p}DENIED_TABLES`)),
        sensitiveRelationDenylist: boolSecureDefault(env(`${p}SENSITIVE_RELATION_DENYLIST`)),
    };
}

/** Fallback datasource seeded from the canonical DATABASE_* vars. */
function fallbackDatasource(): Record<string, unknown> {
    return {
        name: 'main',
        host: env('DATABASE_HOST'),
        port: env('DATABASE_PORT'),
        user: env('DATABASE_USERNAME'),
        password: env('DATABASE_PASSWORD') ?? '',
        database: env('DATABASE_NAME'),
        ssl: bool(env('DATABASE_SSL')),
        defaultSchema: env('DATABASE_DEFAULT_SCHEMA'),
        allowUnsafeStatements: bool(env('DATABASE_ALLOW_UNSAFE_STATEMENTS')),
        deniedTables: list(env('DATABASE_DENIED_TABLES')),
        sensitiveRelationDenylist: boolSecureDefault(env('DATABASE_SENSITIVE_RELATION_DENYLIST')),
    };
}

function buildToken(id: string): Record<string, unknown> {
    const p = `TOKEN_${id.toUpperCase()}_`;
    return {
        id,
        secret: env(`${p}SECRET`),
        datasources: list(env(`${p}DATASOURCES`)),
        mode: (env(`${p}MODE`) ?? 'read').toLowerCase(),
        schemas: list(env(`${p}SCHEMAS`)),
    };
}

export function loadConfig(): RootConfig {
    const dsNames = list(env('DATASOURCES'));
    const rawDatasources =
        dsNames.length > 0 ? dsNames.map(buildDatasource) : env('DATABASE_HOST') ? [fallbackDatasource()] : [];

    const tokenIds = list(env('TOKENS'));
    const rawTokens = tokenIds.map(buildToken);

    const parsed = rootConfigSchema.safeParse({
        port: env('PORT'),
        host: env('HOST'),
        logLevel: env('LOG_LEVEL'),
        maxRowsCeiling: env('MAX_ROWS_CEILING'),
        datasources: rawDatasources,
        tokens: rawTokens,
    });

    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
        throw new Error(`Invalid pg-connection-pool config (check .env):\n${issues}`);
    }

    // Cross-reference check (fail-fast): every token datasource must be known.
    const known = new Set(parsed.data.datasources.map((d) => d.name));
    for (const token of parsed.data.tokens) {
        for (const ds of token.datasources) {
            if (ds !== '*' && !known.has(ds)) {
                throw new Error(`Token "${token.id}" references unknown datasource "${ds}". Known: ${[...known].join(', ')}`);
            }
        }
    }

    return parsed.data;
}
