import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    DATASOURCE_FILE_KEYS,
    datasourceNameFromFile,
    isSecureMode,
    assertSecureMode,
    readDatasourcesDir,
    resolveDatasourcesDir,
} from '../src/config/datasources-dir.js';
import { loadConfig } from '../src/config/load-config.js';

/**
 * Fixtures are REAL directories with REAL modes (testing doc: permission cases are
 * exercised, not mocked). Note the default umask would give every file 0644 — which the
 * reader must refuse — so each fixture states its mode explicitly.
 */
function tmpDir(t: { after: (fn: () => void) => void }): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgcp-dsdir-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeFixture(dir: string, filename: string, body: string, mode = 0o600): string {
    const file = path.join(dir, filename);
    fs.writeFileSync(file, body);
    fs.chmodSync(file, mode);
    return file;
}

const WAREHOUSE = ['HOST=warehouse.internal', 'PORT=5432', 'USER=agent_ro_pg', 'PASSWORD=s3cret', 'DATABASE=analytics'].join('\n');

// ---------------------------------------------------------------- file selection

test('reads *.env only — example.env.disabled and other extensions are ignored', (t) => {
    const dir = tmpDir(t);
    writeFixture(dir, 'warehouse.env', WAREHOUSE);
    writeFixture(dir, 'example.env.disabled', 'HOST=template.example\n');
    writeFixture(dir, 'notes.txt', 'HOST=nope\n');
    writeFixture(dir, 'README', 'HOST=nope\n');

    const { names, source } = readDatasourcesDir(dir);
    assert.deepEqual(names, ['warehouse']);
    assert.equal(source.DS_WAREHOUSE_HOST, 'warehouse.internal');
    assert.equal(source.DS_EXAMPLE_HOST, undefined);
});

test('filename stem becomes the datasource name, lowercased', (t) => {
    const dir = tmpDir(t);
    writeFixture(dir, 'Warehouse.env', WAREHOUSE);
    writeFixture(dir, 'reporting_db-2.env', WAREHOUSE);

    const { names, source } = readDatasourcesDir(dir);
    assert.deepEqual(names.sort(), ['reporting_db-2', 'warehouse']);
    assert.equal(source.DS_WAREHOUSE_HOST, 'warehouse.internal');
    assert.equal(source['DS_REPORTING_DB-2_HOST'], 'warehouse.internal');
});

test('rejects a filename that is not /^[a-z0-9_-]+$/, naming the file', (t) => {
    const dir = tmpDir(t);
    writeFixture(dir, 'ware house.env', WAREHOUSE);
    assert.throws(() => readDatasourcesDir(dir), /ware house\.env/);

    // The pure helper carries the same rule, so callers can check a name without I/O.
    assert.equal(datasourceNameFromFile('Warehouse.env'), 'warehouse');
    assert.throws(() => datasourceNameFromFile('ware house.env'), /ware house\.env/);
    assert.throws(() => datasourceNameFromFile('ware.house.env'), /ware\.house\.env/);
    assert.throws(() => datasourceNameFromFile('ware+house.env'), /ware\+house\.env/);
    // A stray `.env` inside the directory has an empty stem — a plausible operator
    // mistake that must produce a named error, not a crash or a nameless datasource.
    assert.throws(() => datasourceNameFromFile('.env'), /\.env/);
});

test('a name that collides with an Object.prototype property is a normal datasource, not a duplicate', (t) => {
    // `constructor` and `__proto__` both satisfy /^[a-z0-9_-]+$/. Probing a plain object
    // for them returns an INHERITED value, which made the duplicate check reject
    // constructor.env as "defined twice" with a file path that did not exist.
    const dir = tmpDir(t);
    writeFixture(dir, 'constructor.env', WAREHOUSE);
    const { names, source } = readDatasourcesDir(dir);
    assert.deepEqual(names, ['constructor']);
    assert.equal(source.DS_CONSTRUCTOR_HOST, 'warehouse.internal');
});

// NOTE: the "two files claiming one name" path (`warehouse.env` + `Warehouse.env`) has no
// case here on purpose — it can only be staged on a case-sensitive filesystem, and a test
// that silently skips on macOS is worse than none. Duplicate-name rejection is owned by
// reload stage 1 in the test plan; this module's check is the belt to that suspenders.

// ---------------------------------------------------------------- permissions

test('SECURITY: refuses a real mode-644 file, naming both the file and the chmod 600 fix', (t) => {
    // Skips as root: root bypasses permission semantics, so a root CI run would pass
    // this test without the check ever mattering (testing doc, permission caveat).
    if (process.getuid?.() === 0) {
        t.skip('running as root — file mode semantics do not apply');
        return;
    }
    const dir = tmpDir(t);
    const file = writeFixture(dir, 'warehouse.env', WAREHOUSE, 0o644);

    assert.throws(() => readDatasourcesDir(dir), (err: Error) => {
        assert.match(err.message, /warehouse\.env/);
        assert.match(err.message, /644/);
        assert.ok(err.message.includes(`chmod 600 ${file}`), `message must carry the exact fix, got: ${err.message}`);
        return true;
    });
});

test('SECURITY: refuses group- or other-accessible modes generally (644, 640, 604, 660)', () => {
    // Asserted against the checking function given a stat mode, so the verdict is
    // independent of the uid the suite runs as.
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o777, 0o444, 0o601]) {
        assert.equal(isSecureMode(mode), false, `mode ${mode.toString(8)} must be refused`);
        assert.throws(() => assertSecureMode(mode, '/x/warehouse.env'), /warehouse\.env/);
    }
});

test('accepts mode 600 and 400', (t) => {
    for (const mode of [0o600, 0o400, 0o700, 0o000]) {
        assert.equal(isSecureMode(mode), true, `mode ${mode.toString(8)} must be accepted`);
        assert.doesNotThrow(() => assertSecureMode(mode, '/x/warehouse.env'));
    }
    const dir = tmpDir(t);
    writeFixture(dir, 'a.env', WAREHOUSE, 0o600);
    writeFixture(dir, 'b.env', WAREHOUSE, 0o400);
    assert.deepEqual(readDatasourcesDir(dir).names.sort(), ['a', 'b']);
});

test('reports the permission mode as 644, not the raw stat 100644 (file-type bits stripped)', () => {
    // statSync().mode carries S_IFREG; printing it raw would tell the operator to fix a
    // mode that does not exist.
    assert.equal(isSecureMode(0o100644), false);
    assert.throws(() => assertSecureMode(0o100644, '/x/warehouse.env'), (err: Error) => {
        assert.match(err.message, /\b644\b/);
        assert.doesNotMatch(err.message, /100644/);
        return true;
    });
    assert.equal(isSecureMode(0o100600), true);
});

// ---------------------------------------------------------------- normalization

test('bare keys normalize to DS_<NAME>_* and every datasource field is accepted', (t) => {
    const dir = tmpDir(t);
    writeFixture(
        dir,
        'warehouse.env',
        [
            'HOST=warehouse.internal',
            'PORT=5433',
            'USER=agent_ro_pg',
            'PASSWORD=s3cret',
            'DATABASE=analytics',
            'DEFAULT_SCHEMA=public',
            'STATEMENT_TIMEOUT_MS=10000',
            'DENIED_TABLES=billing_accounts',
            'WRITABLE=true',
            'SENSITIVE_RELATION_DENYLIST=false',
        ].join('\n'),
    );

    const { source } = readDatasourcesDir(dir);
    assert.equal(source.DS_WAREHOUSE_HOST, 'warehouse.internal');
    assert.equal(source.DS_WAREHOUSE_PORT, '5433');
    assert.equal(source.DS_WAREHOUSE_USER, 'agent_ro_pg');
    assert.equal(source.DS_WAREHOUSE_PASSWORD, 's3cret');
    assert.equal(source.DS_WAREHOUSE_DATABASE, 'analytics');
    assert.equal(source.DS_WAREHOUSE_DEFAULT_SCHEMA, 'public');
    assert.equal(source.DS_WAREHOUSE_STATEMENT_TIMEOUT_MS, '10000');
    assert.equal(source.DS_WAREHOUSE_DENIED_TABLES, 'billing_accounts');
    assert.equal(source.DS_WAREHOUSE_WRITABLE, 'true');
    assert.equal(source.DS_WAREHOUSE_SENSITIVE_RELATION_DENYLIST, 'false');
    // The directory contributes datasources ONLY — never the id list, which would
    // clobber .env's own DATASOURCES on merge.
    assert.equal(source.DATASOURCES, undefined);
});

test('SECURITY: rejects a key that is not a known datasource field', (t) => {
    const dir = tmpDir(t);
    writeFixture(dir, 'warehouse.env', `${WAREHOUSE}\nTOKENS=agent_rw\nTOKEN_AGENT_RW_SECRET=s\n`);

    assert.throws(() => readDatasourcesDir(dir), (err: Error) => {
        assert.match(err.message, /TOKENS/);
        assert.match(err.message, /warehouse\.env/);
        return true;
    });
});

test('SECURITY: rejects an already-prefixed DS_<NAME>_ key — a file cannot define another datasource', (t) => {
    const dir = tmpDir(t);
    writeFixture(dir, 'warehouse.env', `${WAREHOUSE}\nDS_MAIN_PASSWORD=stolen\n`);
    assert.throws(() => readDatasourcesDir(dir), /DS_MAIN_PASSWORD/);
});

test('comments and blank lines skipped; spaces preserved; KEY= leaves the zod default in place', (t) => {
    const dir = tmpDir(t);
    writeFixture(
        dir,
        'warehouse.env',
        [
            '# warehouse cluster (read-only role)',
            '',
            'HOST=warehouse.internal',
            'PORT=',
            '   ',
            'USER=agent_ro_pg',
            'PASSWORD=p@ss word#1',
            'DATABASE=analytics',
            '# DENIED_TABLES=commented_out',
        ].join('\n'),
    );

    // A hyphenated name too: `-` is legal in a datasource name but NOT in a shell env var,
    // so it is the character most likely to break the DS_<NAME>_ round trip. It only works
    // because the merged map is an injected object, never a real environment.
    writeFixture(dir, 'reporting-2.env', `${WAREHOUSE}\nWRITABLE=true`);

    const { source, names } = readDatasourcesDir(dir);
    assert.equal(source.DS_WAREHOUSE_PORT, '');
    assert.equal(source.DS_WAREHOUSE_PASSWORD, 'p@ss word#1');
    assert.equal(source.DS_WAREHOUSE_DENIED_TABLES, undefined);

    // End-to-end through the loader: the empty PORT must land on the zod default (5432),
    // and every datasource — from any source — must default to read-only.
    const merged = {
        DATASOURCES: names.join(','),
        TOKENS: 't',
        TOKEN_T_SECRET: 'secret',
        TOKEN_T_DATASOURCES: names.join(','),
        TOKEN_T_SCHEMAS: '*',
        ...source,
    };
    const cfg = loadConfig(merged);
    const warehouse = cfg.datasources.find((d) => d.name === 'warehouse')!;
    assert.equal(warehouse.port, 5432);
    assert.equal(warehouse.password, 'p@ss word#1');
    assert.equal(warehouse.writable, false);

    const reporting = cfg.datasources.find((d) => d.name === 'reporting-2')!;
    assert.equal(reporting.host, 'warehouse.internal');
    assert.equal(reporting.writable, true); // explicit WRITABLE=true still opts in
});

test('a malformed line (missing =) is refused, not silently dropped', (t) => {
    // Fail-closed: a typo'd `DENIED_TABLES billing_accounts` that parsed leniently would
    // silently drop a denylist. Datasource files are strict; .env stays lenient.
    const dir = tmpDir(t);
    writeFixture(dir, 'warehouse.env', `${WAREHOUSE}\nDENIED_TABLES billing_accounts\n`);
    assert.throws(() => readDatasourcesDir(dir), (err: Error) => {
        assert.match(err.message, /warehouse\.env/);
        assert.match(err.message, /line 6/);
        return true;
    });
});

// ---------------------------------------------------------------- directory resolution

test('a missing datasources.d/ directory is not an error (the feature is opt-in)', () => {
    const missing = path.join(os.tmpdir(), `pgcp-absent-${process.pid}-${Date.now()}`);
    const res = readDatasourcesDir(missing);
    assert.deepEqual(res.names, []);
    assert.deepEqual(res.source, {});
    assert.equal(res.dir, missing);
});

test('an empty datasources.d/ directory contributes nothing', (t) => {
    const dir = tmpDir(t);
    assert.deepEqual(readDatasourcesDir(dir).names, []);
});

test('directory resolves CWD-relative to ./datasources.d and honours DATASOURCES_DIR', (t) => {
    assert.equal(resolveDatasourcesDir({}), path.resolve(process.cwd(), 'datasources.d'));
    assert.equal(resolveDatasourcesDir({ DATASOURCES_DIR: '/etc/pgcp/ds.d' }), '/etc/pgcp/ds.d');
    assert.equal(resolveDatasourcesDir({ DATASOURCES_DIR: 'conf/ds.d' }), path.resolve(process.cwd(), 'conf/ds.d'));
    assert.equal(resolveDatasourcesDir({ DATASOURCES_DIR: '  ' }), path.resolve(process.cwd(), 'datasources.d'));

    const dir = tmpDir(t);
    writeFixture(dir, 'warehouse.env', WAREHOUSE);
    const { names } = readDatasourcesDir(resolveDatasourcesDir({ DATASOURCES_DIR: dir }));
    assert.deepEqual(names, ['warehouse']);
});

// ---------------------------------------------------------------- drift tripwire

test('the accepted key set is derived from datasourceSchema and matches the DS_* keys the loader reads', () => {
    // Tripwire, deliberately exact: DATASOURCE_FILE_KEYS is derived from
    // datasourceSchema.shape, so a schema field added with a DS_* key that does NOT follow
    // camelCase→SCREAMING_SNAKE would silently become unsettable from a datasource file.
    // Failing here forces whoever adds a field to confirm the key name in load-config.ts.
    assert.deepEqual([...DATASOURCE_FILE_KEYS].sort(), [
        'ALLOW_UNSAFE_STATEMENTS',
        'CONNECTION_TIMEOUT_MS',
        'DATABASE',
        'DEFAULT_SCHEMA',
        'DENIED_TABLES',
        'HOST',
        'IDLE_TIMEOUT_MS',
        'MAX_USES',
        'PASSWORD',
        'POOL_MAX',
        'PORT',
        'SENSITIVE_RELATION_DENYLIST',
        'SSL',
        'STATEMENT_TIMEOUT_MS',
        'USER',
        'WRITABLE',
    ]);
    // `name` is the filename's job, so it is not settable from inside the file.
    assert.equal(DATASOURCE_FILE_KEYS.has('NAME'), false);
});
