/**
 * load-config — turn an env-shaped source map into a validated RootConfig.
 *
 * Flow: read comma-separated `DATASOURCES` / `TOKENS` id lists → expand each id
 * into its `DS_<NAME>_*` / `TOKEN_<ID>_*` keys → assemble plain objects →
 * validate with zod (fail-fast). If NO `DS_*` datasource is configured we seed a
 * single `main` from the canonical `DATABASE_*` vars, so the
 * gateway drops into the existing stack with zero new config.
 *
 * The source is a PARAMETER (defaulting to `process.env`) rather than a direct
 * `process.env` read. Reload needs to validate a *candidate* config — merged from
 * `.env` plus `datasources.d/*.env` — without mutating the live process
 * environment, which would make a rejected reload leave debris behind. The same
 * seam lets tests build a config from a plain object instead of mutating global
 * state. Production never writes `process.env`, which is what makes it a valid
 * comparison baseline for the boot-only keys zod never sees (see reload.ts).
 */
import { rootConfigSchema, type RootConfig } from './config.schema.js';

/** An env-shaped map: `process.env` itself, or a merged candidate built for reload. */
export type ConfigSource = Record<string, string | undefined>;

/** Trimmed source value, or undefined when missing/empty (so zod defaults apply). */
function read(source: ConfigSource, key: string): string | undefined {
    const v = source[key];
    if (v === undefined) return undefined;
    const t = v.trim();
    return t === '' ? undefined : t;
}

/**
 * Split a comma-separated env value into a clean list.
 *
 * EXPORTED because `config-sources.ts` must split `DATASOURCES` the same way this file
 * does. It had its own copy; the two agreed, but drift between them would be
 * security-relevant rather than cosmetic — `config-sources` uses the split to run the
 * cross-source COLLISION CHECK, while this file re-splits the joined string to decide
 * which datasources actually get built with credentials. Two different answers means the
 * check guards a different set than the one that gets credentials, which is precisely the
 * silent credential override the check exists to prevent. Same reasoning, and the same
 * fix, as `capabilityAllows` and `isSystemSchema`.
 */
export function list(v: string | undefined): string[] {
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

/** Assemble one raw datasource object from `DS_<NAME>_*` keys. Module-private: the
 *  merge layer feeds this through `loadConfig`, never directly. */
function buildDatasource(source: ConfigSource, name: string): Record<string, unknown> {
    const p = `DS_${name.toUpperCase()}_`;
    const env = (key: string): string | undefined => read(source, key);
    return {
        name,
        // READ-ONLY BY DEFAULT, from every config source, with no exceptions — this
        // gateway's headline invariant is that it does not write, so a datasource must
        // never become writable by omission. An earlier revision defaulted `.env`
        // datasources to writable for backward compatibility and passed the default in as
        // a per-source parameter; that was removed deliberately. One unconditional default
        // in one place cannot be reopened by getting a call site wrong, and "you must opt
        // in, in writing, on the datasource" is the property worth having.
        //
        // bool(), NOT boolSecureDefault(): this is an opt-IN to a dangerous capability, so
        // only an exact "true" grants it and any typo stays read-only. That is the exact
        // INVERSE of SENSITIVE_RELATION_DENYLIST, where a typo must keep the safety net on
        // — both converge on "a mistake leaves you safer", which is why they differ.
        writable: bool(env(`${p}WRITABLE`)) ?? false,
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

/**
 * The canonical `DATABASE_*` vars, renamed to the `DS_MAIN_*` keys `buildDatasource`
 * already understands.
 *
 * Expressed as a key MAP rather than a second object-builder so the fallback cannot drift
 * from the primary path: every default, every converter, and the `writable` rule are
 * `buildDatasource`'s, applied once. Fields absent here (`POOL_MAX`, timeouts, `MAX_USES`)
 * simply fall through to their zod defaults, exactly as before.
 */
const FALLBACK_KEY_MAP: Readonly<Record<string, string>> = {
    DATABASE_HOST: 'DS_MAIN_HOST',
    DATABASE_PORT: 'DS_MAIN_PORT',
    DATABASE_USERNAME: 'DS_MAIN_USER',
    DATABASE_PASSWORD: 'DS_MAIN_PASSWORD',
    DATABASE_NAME: 'DS_MAIN_DATABASE',
    DATABASE_SSL: 'DS_MAIN_SSL',
    DATABASE_DEFAULT_SCHEMA: 'DS_MAIN_DEFAULT_SCHEMA',
    DATABASE_WRITABLE: 'DS_MAIN_WRITABLE',
    DATABASE_ALLOW_UNSAFE_STATEMENTS: 'DS_MAIN_ALLOW_UNSAFE_STATEMENTS',
    DATABASE_DENIED_TABLES: 'DS_MAIN_DENIED_TABLES',
    DATABASE_SENSITIVE_RELATION_DENYLIST: 'DS_MAIN_SENSITIVE_RELATION_DENYLIST',
};

/**
 * The `DATABASE_*` fallback as `DS_MAIN_*` keys, or null when it does not apply.
 *
 * Exported for `config-sources.ts`, which must MATERIALIZE the fallback before merging:
 * it has to set `DATASOURCES` explicitly to introduce `datasources.d/` names, and setting
 * that key is precisely what suppresses the fallback below. Without materializing it, a
 * zero-config deployment that added its first datasource file would silently lose `main`.
 */
export function fallbackAsDsKeys(source: ConfigSource): ConfigSource | null {
    if (read(source, 'DATABASE_HOST') === undefined) return null;
    const out: ConfigSource = {};
    for (const [from, to] of Object.entries(FALLBACK_KEY_MAP)) {
        const v = source[from];
        if (v !== undefined) out[to] = v;
    }
    return out;
}

function buildToken(source: ConfigSource, id: string): Record<string, unknown> {
    const p = `TOKEN_${id.toUpperCase()}_`;
    const env = (key: string): string | undefined => read(source, key);
    return {
        id,
        secret: env(`${p}SECRET`),
        datasources: list(env(`${p}DATASOURCES`)),
        mode: (env(`${p}MODE`) ?? 'read').toLowerCase(),
        schemas: list(env(`${p}SCHEMAS`)),
    };
}

export function loadConfig(source: ConfigSource = process.env): RootConfig {
    const env = (key: string): string | undefined => read(source, key);

    const dsNames = list(env('DATASOURCES'));
    // The fallback is built through buildDatasource over RENAMED keys — and over ONLY the
    // renamed keys, so a stray `DS_MAIN_*` in the environment cannot leak into a config
    // the operator expressed entirely as `DATABASE_*`.
    const fallbackKeys = dsNames.length === 0 ? fallbackAsDsKeys(source) : null;
    const rawDatasources =
        dsNames.length > 0
            ? dsNames.map((name) => buildDatasource(source, name))
            : fallbackKeys
              ? [buildDatasource(fallbackKeys, 'main')]
              : [];

    const tokenIds = list(env('TOKENS'));
    const rawTokens = tokenIds.map((id) => buildToken(source, id));

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
