import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/load-config.js';
import { datasourceSchema } from '../src/config/config.schema.js';

// load-config reads process.env; snapshot + restore around each test.
const KEYS = Object.keys(process.env);
afterEach(() => {
    for (const k of Object.keys(process.env)) {
        if (!KEYS.includes(k)) delete process.env[k];
    }
});

function reset(): void {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('DS_') || k.startsWith('TOKEN_') || k.startsWith('DATABASE_') || k === 'DATASOURCES' || k === 'TOKENS') {
            delete process.env[k];
        }
    }
}

test('parses DS_* datasources and TOKEN_* tokens', () => {
    reset();
    process.env.DATASOURCES = 'main';
    process.env.DS_MAIN_HOST = 'db.local';
    process.env.DS_MAIN_USER = 'pg';
    process.env.DS_MAIN_DATABASE = 'appdb';
    process.env.DS_MAIN_SSL = 'false';
    process.env.DS_MAIN_POOL_MAX = '7';
    process.env.TOKENS = 'agent_ro';
    process.env.TOKEN_AGENT_RO_SECRET = 'sekret';
    process.env.TOKEN_AGENT_RO_DATASOURCES = 'main';
    process.env.TOKEN_AGENT_RO_MODE = 'read';
    process.env.TOKEN_AGENT_RO_SCHEMAS = '*';

    const cfg = loadConfig();
    assert.equal(cfg.datasources.length, 1);
    assert.equal(cfg.datasources[0].host, 'db.local');
    assert.equal(cfg.datasources[0].ssl, false);
    assert.equal(cfg.datasources[0].poolMax, 7);
    assert.equal(cfg.datasources[0].defaultSchema, 'public'); // default applied
    assert.equal(cfg.tokens[0].id, 'agent_ro');
    assert.equal(cfg.tokens[0].mode, 'read');
});

test('SSL "false" string parses to boolean false (not Boolean("false")===true)', () => {
    reset();
    process.env.DATASOURCES = 'main';
    process.env.DS_MAIN_HOST = 'h';
    process.env.DS_MAIN_USER = 'u';
    process.env.DS_MAIN_DATABASE = 'd';
    process.env.DS_MAIN_SSL = 'false';
    process.env.TOKENS = 't';
    process.env.TOKEN_T_SECRET = 's';
    process.env.TOKEN_T_DATASOURCES = 'main';
    process.env.TOKEN_T_SCHEMAS = '*';
    assert.equal(loadConfig().datasources[0].ssl, false);
});

test('seeds main from DATABASE_* when no DS_* present', () => {
    reset();
    process.env.DATABASE_HOST = 'canon.local';
    process.env.DATABASE_PORT = '5433';
    process.env.DATABASE_USERNAME = 'canon';
    process.env.DATABASE_NAME = 'canondb';
    process.env.DATABASE_SSL = 'true';
    process.env.TOKENS = 't';
    process.env.TOKEN_T_SECRET = 's';
    process.env.TOKEN_T_DATASOURCES = 'main';
    process.env.TOKEN_T_SCHEMAS = '*';

    const cfg = loadConfig();
    assert.equal(cfg.datasources.length, 1);
    assert.equal(cfg.datasources[0].name, 'main');
    assert.equal(cfg.datasources[0].host, 'canon.local');
    assert.equal(cfg.datasources[0].port, 5433);
    assert.equal(cfg.datasources[0].ssl, true);
});

test('throws (fail-fast) when no datasource can be resolved', () => {
    reset();
    process.env.TOKENS = 't';
    process.env.TOKEN_T_SECRET = 's';
    process.env.TOKEN_T_DATASOURCES = 'main';
    process.env.TOKEN_T_SCHEMAS = '*';
    assert.throws(() => loadConfig(), /Invalid pg-connection-pool config/);
});

test('throws when a token is missing its secret', () => {
    reset();
    process.env.DATASOURCES = 'main';
    process.env.DS_MAIN_HOST = 'h';
    process.env.DS_MAIN_USER = 'u';
    process.env.DS_MAIN_DATABASE = 'd';
    process.env.TOKENS = 't';
    // no TOKEN_T_SECRET
    process.env.TOKEN_T_DATASOURCES = 'main';
    process.env.TOKEN_T_SCHEMAS = '*';
    assert.throws(() => loadConfig(), /Invalid pg-connection-pool config/);
});

test('throws when a token references an unknown datasource', () => {
    reset();
    process.env.DATASOURCES = 'main';
    process.env.DS_MAIN_HOST = 'h';
    process.env.DS_MAIN_USER = 'u';
    process.env.DS_MAIN_DATABASE = 'd';
    process.env.TOKENS = 't';
    process.env.TOKEN_T_SECRET = 's';
    process.env.TOKEN_T_DATASOURCES = 'ghost';
    process.env.TOKEN_T_SCHEMAS = '*';
    assert.throws(() => loadConfig(), /unknown datasource "ghost"/);
});

/** Minimal valid single-datasource env; the caller sets DS_MAIN_DENIED_TABLES. */
function minimalEnv(): void {
    reset();
    process.env.DATASOURCES = 'main';
    process.env.DS_MAIN_HOST = 'h';
    process.env.DS_MAIN_USER = 'u';
    process.env.DS_MAIN_DATABASE = 'd';
    process.env.TOKENS = 't';
    process.env.TOKEN_T_SECRET = 's';
    process.env.TOKEN_T_DATASOURCES = 'main';
    process.env.TOKEN_T_SCHEMAS = '*';
}

test('DENIED_TABLES parses a comma list (trimmed) into deniedTables', () => {
    minimalEnv();
    process.env.DS_MAIN_DENIED_TABLES = 'user, public.role';
    assert.deepEqual(loadConfig().datasources[0].deniedTables, ['user', 'public.role']);
});

test('DENIED_TABLES unset → empty deniedTables (code default is generic)', () => {
    minimalEnv();
    assert.deepEqual(loadConfig().datasources[0].deniedTables, []);
});

test('DENIED_TABLES with a malformed entry (a.b.c) fails boot fast', () => {
    minimalEnv();
    process.env.DS_MAIN_DENIED_TABLES = 'user, a.b.c';
    assert.throws(() => loadConfig(), /table.*or.*schema\.table|Invalid pg-connection-pool config/);
});

test('sensitiveRelationDenylist defaults to TRUE (secure-by-default)', () => {
    minimalEnv();
    delete process.env.DS_MAIN_SENSITIVE_RELATION_DENYLIST;
    assert.equal(loadConfig().datasources[0].sensitiveRelationDenylist, true);
});

test('SENSITIVE_RELATION_DENYLIST=false turns the built-in off', () => {
    minimalEnv();
    process.env.DS_MAIN_SENSITIVE_RELATION_DENYLIST = 'false';
    assert.equal(loadConfig().datasources[0].sensitiveRelationDenylist, false);
    delete process.env.DS_MAIN_SENSITIVE_RELATION_DENYLIST;
});

/** Minimal valid env as a PLAIN OBJECT, for the injected-source cases below. */
function minimalSource(extra: Record<string, string> = {}): Record<string, string | undefined> {
    return {
        DATASOURCES: 'main',
        DS_MAIN_HOST: 'injected.local',
        DS_MAIN_USER: 'u',
        DS_MAIN_DATABASE: 'd',
        TOKENS: 't',
        TOKEN_T_SECRET: 's',
        TOKEN_T_DATASOURCES: 'main',
        TOKEN_T_SCHEMAS: '*',
        ...extra,
    };
}

test('loadConfig(source) reads the injected map, NOT process.env', () => {
    reset();
    // Deliberately contradictory: process.env names a different host and datasource.
    // If the loader leaks back to process.env, one of these assertions fails.
    process.env.DATASOURCES = 'ghost';
    process.env.DS_GHOST_HOST = 'from-process-env.local';
    process.env.DS_GHOST_USER = 'u';
    process.env.DS_GHOST_DATABASE = 'd';

    const cfg = loadConfig(minimalSource());
    assert.equal(cfg.datasources.length, 1);
    assert.equal(cfg.datasources[0].name, 'main');
    assert.equal(cfg.datasources[0].host, 'injected.local');
});

test('loadConfig() defaults to process.env when no source is passed', () => {
    minimalEnv();
    process.env.DS_MAIN_HOST = 'from-process-env.local';
    assert.equal(loadConfig().datasources[0].host, 'from-process-env.local');
});

test('injected source preserves DATABASE_* fallback, cross-reference and boolSecureDefault behaviour', () => {
    reset();
    // DATABASE_* fallback under injection (no DS_* keys in the map).
    const fallback = loadConfig({
        DATABASE_HOST: 'canon.injected',
        DATABASE_USERNAME: 'canon',
        DATABASE_NAME: 'canondb',
        TOKENS: 't',
        TOKEN_T_SECRET: 's',
        TOKEN_T_DATASOURCES: 'main',
        TOKEN_T_SCHEMAS: '*',
    });
    assert.equal(fallback.datasources[0].name, 'main');
    assert.equal(fallback.datasources[0].host, 'canon.injected');

    // Token cross-reference failure still throws under injection.
    assert.throws(() => loadConfig(minimalSource({ TOKEN_T_DATASOURCES: 'ghost' })), /unknown datasource "ghost"/);

    // boolSecureDefault asymmetry survives injection: a typo keeps the net ON.
    assert.equal(loadConfig(minimalSource({ DS_MAIN_SENSITIVE_RELATION_DENYLIST: '1' })).datasources[0].sensitiveRelationDenylist, true);
    assert.equal(loadConfig(minimalSource({ DS_MAIN_SENSITIVE_RELATION_DENYLIST: 'off' })).datasources[0].sensitiveRelationDenylist, false);
});

// ---------------------------------------------------------------------------
// `writable` — required in the schema, and FAIL-CLOSED from every config source.
// There is no per-source asymmetry: .env, datasources.d/ and the DATABASE_*
// fallback all default to read-only, so a datasource can only become writable by
// an operator saying so explicitly, in writing, on that datasource.
// ---------------------------------------------------------------------------

test('SECURITY: `writable` is REQUIRED — a datasource omitting it fails to parse', () => {
    const withoutWritable = {
        name: 'main',
        host: 'h',
        user: 'u',
        database: 'd',
        password: '',
    };
    assert.equal(datasourceSchema.safeParse(withoutWritable).success, false);
    // ...and the same object parses once writable is supplied, proving nothing
    // ELSE in the fixture is what made it fail.
    assert.equal(datasourceSchema.safeParse({ ...withoutWritable, writable: true }).success, true);
});

test('SECURITY: .env DS_X_WRITABLE absent ⇒ writable FALSE (fail-closed everywhere)', () => {
    // Deliberately NOT backward compatible. This gateway's headline invariant is that it
    // is read-only, so a datasource must never become writable by omission — an operator
    // who wants writes says so, on the datasource, in writing.
    assert.equal(loadConfig(minimalSource()).datasources[0].writable, false);
});

test('.env DS_X_WRITABLE=false ⇒ writable false', () => {
    assert.equal(loadConfig(minimalSource({ DS_MAIN_WRITABLE: 'false' })).datasources[0].writable, false);
});

test('SECURITY: every source defaults the same way — there is no per-source asymmetry left', () => {
    // .env, datasources.d/ and the DATABASE_* fallback all fail closed. One rule, one
    // place: three coordinated defaults would be three chances to reopen the hole.
    assert.equal(loadConfig(minimalSource()).datasources[0].writable, false);
    assert.equal(loadConfig(minimalSource({ DS_MAIN_WRITABLE: 'true' })).datasources[0].writable, true);
});

test('SECURITY: DATABASE_* fallback datasource ⇒ writable FALSE too', () => {
    reset();
    const cfg = loadConfig({
        DATABASE_HOST: 'canon.local',
        DATABASE_USERNAME: 'canon',
        DATABASE_NAME: 'canondb',
        TOKENS: 't',
        TOKEN_T_SECRET: 's',
        TOKEN_T_DATASOURCES: 'main',
        TOKEN_T_SCHEMAS: '*',
    });
    assert.equal(cfg.datasources[0].writable, false);
});

test('WRITABLE uses plain bool(): a typo is NOT treated as true', () => {
    // bool() (not boolSecureDefault) is correct here — this is an opt-IN to a
    // dangerous capability, so anything that isn't exactly "true" must not grant it.
    for (const v of ['1', 'yes', 'on', 'TRUE']) {
        const cfg = loadConfig(minimalSource({ DS_MAIN_WRITABLE: v }));
        assert.equal(cfg.datasources[0].writable, v === 'TRUE', `value=${v}`);
    }
});

test('SENSITIVE_RELATION_DENYLIST is fail-CLOSED: a typo like "1" keeps it ON', () => {
    minimalEnv();
    for (const v of ['1', 'yes', 'on', 'enabled', 'True']) {
        process.env.DS_MAIN_SENSITIVE_RELATION_DENYLIST = v;
        assert.equal(loadConfig().datasources[0].sensitiveRelationDenylist, true, `value=${v}`);
    }
    // only explicit off-values disable it
    for (const v of ['false', '0', 'no', 'off']) {
        process.env.DS_MAIN_SENSITIVE_RELATION_DENYLIST = v;
        assert.equal(loadConfig().datasources[0].sensitiveRelationDenylist, false, `value=${v}`);
    }
    delete process.env.DS_MAIN_SENSITIVE_RELATION_DENYLIST;
});
