/**
 * config-sources — the ONE place every config source is gathered.
 *
 * Every case here is a regression for a defect that 339 passing tests did not catch,
 * found in phase-7 review. They share a theme: boot and reload were reading different
 * worlds, and each divergence failed in a direction that looked like success.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherConfigSources, resolveConfig } from '../src/config/config-sources.js';

interface Fixture {
    dir: string;
    envPath: string;
    dsDir: string;
    cleanup(): void;
}

function fixture(): Fixture {
    const dir = mkdtempSync(join(tmpdir(), 'pgcp-sources-'));
    const dsDir = join(dir, 'datasources.d');
    mkdirSync(dsDir);
    return { dir, envPath: join(dir, '.env'), dsDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeDs(f: Fixture, name: string, body: string, mode = 0o600): void {
    const p = join(f.dsDir, `${name}.env`);
    writeFileSync(p, body);
    chmodSync(p, mode);
}

const WAREHOUSE = ['HOST=warehouse.internal', 'USER=agent_ro', 'PASSWORD=whpw', 'DATABASE=analytics'].join('\n');
const TOKENS_WILDCARD = ['TOKENS=t', 'TOKEN_T_SECRET=s', 'TOKEN_T_DATASOURCES=*', 'TOKEN_T_SCHEMAS=*'].join('\n');

function opts(f: Fixture, baseEnv: Record<string, string | undefined> = {}) {
    return { envPath: f.envPath, datasourcesDir: f.dsDir, baseEnv };
}

// --- the critical one: boot must see the directory ------------------------------

test('BOOT reads datasources.d/ — a directory datasource survives a restart', (t) => {
    const f = fixture();
    t.after(f.cleanup);
    writeFileSync(f.envPath, ['DATASOURCES=main', 'DS_MAIN_HOST=h', 'DS_MAIN_USER=u', 'DS_MAIN_DATABASE=d', TOKENS_WILDCARD].join('\n'));
    writeDs(f, 'warehouse', WAREHOUSE);

    // resolveConfig is what BOTH entrypoints now call. Before the fix they called bare
    // loadConfig(process.env), so a directory datasource existed only after a SIGHUP and
    // evaporated on the next restart.
    const cfg = resolveConfig(opts(f));
    assert.deepEqual(cfg.datasources.map((d) => d.name).sort(), ['main', 'warehouse']);
});

test('BOOT does not hard-fail when a token names a directory-only datasource', (t) => {
    const f = fixture();
    t.after(f.cleanup);
    // The explicit-grant form. Before the fix this threw at boot with
    // `Token "t" references unknown datasource "warehouse"` — an error naming the token
    // rather than the directory nobody read, so the message pointed away from the cause.
    writeFileSync(
        f.envPath,
        ['DATASOURCES=main', 'DS_MAIN_HOST=h', 'DS_MAIN_USER=u', 'DS_MAIN_DATABASE=d', 'TOKENS=t', 'TOKEN_T_SECRET=s', 'TOKEN_T_DATASOURCES=main,warehouse', 'TOKEN_T_SCHEMAS=*'].join('\n'),
    );
    writeDs(f, 'warehouse', WAREHOUSE);

    const cfg = resolveConfig(opts(f));
    assert.ok(cfg.datasources.some((d) => d.name === 'warehouse'));
});

// --- the DATABASE_* fallback must survive contact with the directory -------------

test('the first datasources.d/ file does NOT delete the DATABASE_* fallback datasource', (t) => {
    const f = fixture();
    t.after(f.cleanup);
    // Zero-config deployment: only DATABASE_* set, no DATASOURCES. Adding the FIRST
    // datasource file used to report `added:['warehouse'], removed:['main']` — the
    // operator adds a datasource and silently loses their primary one.
    writeFileSync(f.envPath, ['DATABASE_HOST=canon.local', 'DATABASE_USERNAME=canon', 'DATABASE_NAME=canondb', TOKENS_WILDCARD].join('\n'));
    writeDs(f, 'warehouse', WAREHOUSE);

    const cfg = resolveConfig(opts(f));
    assert.deepEqual(cfg.datasources.map((d) => d.name).sort(), ['main', 'warehouse']);
    assert.equal(cfg.datasources.find((d) => d.name === 'main')?.host, 'canon.local');
});

test('the materialized fallback keeps every DATABASE_* field and its defaults', (t) => {
    const f = fixture();
    t.after(f.cleanup);
    writeFileSync(
        f.envPath,
        ['DATABASE_HOST=canon.local', 'DATABASE_PORT=5433', 'DATABASE_USERNAME=canon', 'DATABASE_NAME=canondb', 'DATABASE_SSL=true', 'DATABASE_DEFAULT_SCHEMA=reporting', TOKENS_WILDCARD].join('\n'),
    );
    writeDs(f, 'warehouse', WAREHOUSE);

    const main = resolveConfig(opts(f)).datasources.find((d) => d.name === 'main')!;
    assert.equal(main.port, 5433);
    assert.equal(main.ssl, true);
    assert.equal(main.defaultSchema, 'reporting');
    assert.equal(main.poolMax, 5); // untouched by the key map ⇒ zod default, as before
    assert.equal(main.writable, false); // fail-closed like every other source
});

test('a stray DS_MAIN_* key cannot leak into a config expressed only as DATABASE_*', (t) => {
    const f = fixture();
    t.after(f.cleanup);
    writeFileSync(f.envPath, ['DATABASE_HOST=canon.local', 'DATABASE_USERNAME=canon', 'DATABASE_NAME=canondb', TOKENS_WILDCARD].join('\n'));

    // The fallback is built from the RENAMED keys only, so this must not be picked up.
    const cfg = resolveConfig(opts(f, { DS_MAIN_HOST: 'hijacked.local', DS_MAIN_WRITABLE: 'true' }));
    const main = cfg.datasources.find((d) => d.name === 'main')!;
    assert.equal(main.host, 'canon.local');
    assert.equal(main.writable, false);
});

// --- collision detection is case-insensitive -------------------------------------

test('SECURITY: a case-differing name collision is REFUSED, not silently merged', (t) => {
    const f = fixture();
    t.after(f.cleanup);
    // `buildDatasource` uppercases to derive DS_<NAME>_*, so `Warehouse` and `warehouse`
    // read the SAME keys. A verbatim comparison missed this and produced a per-key HYBRID:
    // deniedTables from .env, host/password/writable/allowUnsafeStatements from the file —
    // silently turning a read-only datasource writable with its guards off.
    writeFileSync(
        f.envPath,
        ['DATASOURCES=main,Warehouse', 'DS_MAIN_HOST=h', 'DS_MAIN_USER=u', 'DS_MAIN_DATABASE=d', 'DS_WAREHOUSE_HOST=env.internal', 'DS_WAREHOUSE_USER=envuser', 'DS_WAREHOUSE_DATABASE=envdb', TOKENS_WILDCARD].join('\n'),
    );
    writeDs(f, 'warehouse', WAREHOUSE);

    assert.throws(() => gatherConfigSources(opts(f)), /both .env and .*warehouse\.env/);
    assert.throws(() => gatherConfigSources(opts(f)), /case/i);
});

test('SECURITY: an exact-name collision is still refused, naming the file', (t) => {
    const f = fixture();
    t.after(f.cleanup);
    writeFileSync(f.envPath, ['DATASOURCES=warehouse', 'DS_WAREHOUSE_HOST=h', 'DS_WAREHOUSE_USER=u', 'DS_WAREHOUSE_DATABASE=d', TOKENS_WILDCARD].join('\n'));
    writeDs(f, 'warehouse', WAREHOUSE);

    assert.throws(() => gatherConfigSources(opts(f)), /warehouse\.env/);
});

test('SECURITY: two .env names differing only by case are refused (they read the same keys)', (t) => {
    const f = fixture();
    t.after(f.cleanup);
    writeFileSync(f.envPath, ['DATASOURCES=Main,main', 'DS_MAIN_HOST=h', 'DS_MAIN_USER=u', 'DS_MAIN_DATABASE=d', TOKENS_WILDCARD].join('\n'));

    // Not a cross-source case — one datasource wearing two labels, both resolving to
    // DS_MAIN_*. Serving it twice is a phantom duplicate, so refuse instead.
    assert.throws(() => gatherConfigSources(opts(f)), /differ only by case/);
});

// --- the opt-in property must hold ------------------------------------------------

test('a missing datasources.d/ directory is not an error (the feature is opt-in)', (t) => {
    const f = fixture();
    t.after(f.cleanup);
    rmSync(f.dsDir, { recursive: true });
    writeFileSync(f.envPath, ['DATASOURCES=main', 'DS_MAIN_HOST=h', 'DS_MAIN_USER=u', 'DS_MAIN_DATABASE=d', TOKENS_WILDCARD].join('\n'));

    const cfg = resolveConfig(opts(f));
    assert.deepEqual(cfg.datasources.map((d) => d.name), ['main']);
});

test('a missing .env is not an error (config may come entirely from the environment)', (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const cfg = resolveConfig(
        opts(f, { DATASOURCES: 'main', DS_MAIN_HOST: 'h', DS_MAIN_USER: 'u', DS_MAIN_DATABASE: 'd', TOKENS: 't', TOKEN_T_SECRET: 's', TOKEN_T_DATASOURCES: '*', TOKEN_T_SCHEMAS: '*' }),
    );
    assert.deepEqual(cfg.datasources.map((d) => d.name), ['main']);
});

test('SECURITY: a bad-permission datasource file makes boot throw, naming the chmod fix', (t) => {
    const f = fixture();
    t.after(f.cleanup);
    if (process.getuid?.() === 0) return; // root bypasses mode checks
    writeFileSync(f.envPath, ['DATASOURCES=main', 'DS_MAIN_HOST=h', 'DS_MAIN_USER=u', 'DS_MAIN_DATABASE=d', TOKENS_WILDCARD].join('\n'));
    writeDs(f, 'warehouse', WAREHOUSE, 0o644);

    // Boot fails fast where reload refuses — the one sanctioned difference, and only
    // because nothing is serving yet at boot.
    assert.throws(() => resolveConfig(opts(f)), /chmod 600/);
});

test('SECURITY: leftover .env DS_<NAME>_* keys cannot override a datasources.d/ datasource', (t) => {
    const f = fixture();
    t.after(f.cleanup);
    // The migration the README invites: move `warehouse` out of .env into the directory,
    // drop it from DATASOURCES, forget to delete its old key block. Those leftovers are
    // invisible to the collision check (which compares against the DATASOURCES LIST), and
    // `dir.source` only overwrites the keys the FILE sets — so everything else survived.
    // The file-defined datasource came up WRITABLE with BOTH guards disabled, on a stale
    // password, from keys the operator believed were inert.
    writeFileSync(
        f.envPath,
        [
            'DATASOURCES=main',
            'DS_MAIN_HOST=h',
            'DS_MAIN_USER=u',
            'DS_MAIN_DATABASE=d',
            'DS_WAREHOUSE_PASSWORD=stale-env-password',
            'DS_WAREHOUSE_WRITABLE=true',
            'DS_WAREHOUSE_ALLOW_UNSAFE_STATEMENTS=true',
            'DS_WAREHOUSE_DENIED_TABLES=',
            TOKENS_WILDCARD,
        ].join('\n'),
    );
    writeDs(f, 'warehouse', ['HOST=warehouse.internal', 'USER=agent_ro', 'PASSWORD=filepw', 'DATABASE=analytics'].join('\n'));

    const wh = resolveConfig(opts(f)).datasources.find((d) => d.name === 'warehouse')!;
    assert.equal(wh.writable, false, 'a leftover .env key must not make a file datasource writable');
    assert.equal(wh.allowUnsafeStatements, false, 'a leftover .env key must not disable the guards');
    assert.equal(wh.password, 'filepw', 'the FILE owns the credential, not a stale .env key');
});
