import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServices } from '../src/services.js';
import { buildApp } from '../src/build-app.js';
import { registerTools } from '../src/mcp/tools.js';
import { buildInstructions } from '../src/mcp/create-mcp-server.js';
import type { Capabilities } from '../src/auth/token-auth.js';
import type { DatasourceConfig, RootConfig } from '../src/config/config.schema.js';
import { makeConfig, silentLogger, StubDriver } from './helpers.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

/** Minimal McpServer stand-in that captures tool registrations. */
class FakeMcp {
    tools = new Map<string, { config: Record<string, unknown>; handler: Handler }>();
    registerTool(name: string, config: Record<string, unknown>, handler: Handler): unknown {
        this.tools.set(name, { config, handler });
        return {};
    }
}

function setup(stub: StubDriver) {
    const services = buildServices(makeConfig(), silentLogger, stub);
    const fake = new FakeMcp();
    return { services, fake };
}

const roCaps: Capabilities = { id: 'agent_ro', datasources: ['main'], canWrite: false, schemas: ['*'] };
const rwCaps: Capabilities = { id: 'svc_rw', datasources: ['main'], canWrite: true, schemas: ['public'] };

after(() => undefined);

test('registers exactly the 5 tools', () => {
    const stub = new StubDriver();
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);
    assert.deepEqual([...fake.tools.keys()].sort(), ['describe_table', 'list_datasources', 'list_schemas', 'list_tables', 'run_query']);
});

test('run_query delegates to QueryService and returns neutral result as content', async () => {
    const stub = new StubDriver();
    stub.userResult = { fields: [{ name: 'id', dataType: 'uuid' }], rows: [{ id: 'a' }], rowCount: 1, command: 'SELECT' };
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);

    const res = await fake.tools.get('run_query')!.handler({ datasource: 'main', sql: 'SELECT id FROM t' });
    assert.notEqual(res.isError, true);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.rowCount, 1);
    assert.deepEqual(payload.columns, [{ name: 'id', dataType: 'uuid' }]);
    // Went through the guarded txn path.
    assert.ok(stub.sqls().includes('BEGIN TRANSACTION READ ONLY'));
});

test('run_query with readOnly:false under a read token → isError (write-not-permitted)', async () => {
    const stub = new StubDriver();
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);
    const res = await fake.tools.get('run_query')!.handler({ datasource: 'main', sql: 'INSERT INTO t VALUES (1)', readOnly: false });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /write-not-permitted/);
    assert.equal(stub.connectCount, 0); // denied before DB contact
});

test('run_query with a datasource outside caps → isError', async () => {
    const stub = new StubDriver();
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);
    const res = await fake.tools.get('run_query')!.handler({ datasource: 'ghost', sql: 'SELECT 1' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not permitted/);
});

test('run_query write under a write token commits and reports rowsAffected', async () => {
    const stub = new StubDriver();
    stub.userResult = { fields: [], rows: [], rowCount: 2, command: 'UPDATE' };
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, rwCaps);
    const res = await fake.tools.get('run_query')!.handler({ datasource: 'main', schema: 'public', sql: 'UPDATE t SET a=1', readOnly: false });
    assert.notEqual(res.isError, true);
    assert.equal(JSON.parse(res.content[0].text).rowsAffected, 2);
    assert.equal(stub.sqls()[0], 'BEGIN'); // write txn
});

test('list_tables delegates to IntrospectService', async () => {
    const stub = new StubDriver();
    stub.userResult = { fields: [], rows: [{ table_name: 't1', table_type: 'BASE TABLE' }], rowCount: 1, command: 'SELECT' };
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);
    const res = await fake.tools.get('list_tables')!.handler({ datasource: 'main', schema: 'public' });
    assert.deepEqual(JSON.parse(res.content[0].text), { tables: [{ name: 't1', type: 'BASE TABLE' }] });
});

// ── relation guard over MCP ─────────────────────────────────────────────────────

test('run_query: a catalog read is rejected (isError) before any DB contact', async () => {
    const stub = new StubDriver();
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);
    const res = await fake.tools.get('run_query')!.handler({ datasource: 'main', sql: 'SELECT * FROM pg_tables' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not readable through run_query/);
    assert.equal(stub.connectCount, 0);
});

test('run_query: a schema-scoped token reading another schema → isError (caps violation)', async () => {
    const stub = new StubDriver();
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, rwCaps); // schemas:['public']
    const res = await fake.tools.get('run_query')!.handler({ datasource: 'main', sql: 'SELECT * FROM "tenant_b".t' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /"tenant_b" not permitted/);
    assert.equal(stub.connectCount, 0);
});

// The MCP twin of the HTTP unreachability test: naming the internal trust flag in the
// tool args must NOT bypass the guard (the handler never forwards it to run()).
test('run_query: naming the internal trust flag in args does NOT bypass the guard', async () => {
    const stub = new StubDriver();
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);
    const res = await fake.tools.get('run_query')!.handler({ datasource: 'main', sql: 'SELECT * FROM pg_tables', internalCatalogQuery: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not readable through run_query/);
    assert.equal(stub.connectCount, 0);
});

test('introspection tools still return data via the internal trusted path', async () => {
    const stub = new StubDriver();
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);

    stub.userResult = { fields: [], rows: [{ schema_name: 'public' }], rowCount: 1, command: 'SELECT' };
    const schemas = await fake.tools.get('list_schemas')!.handler({ datasource: 'main' });
    assert.deepEqual(JSON.parse(schemas.content[0].text), { schemas: ['public'] });

    stub.userResult = { fields: [], rows: [{ table_name: 't1', table_type: 'BASE TABLE' }], rowCount: 1, command: 'SELECT' };
    const tables = await fake.tools.get('list_tables')!.handler({ datasource: 'main', schema: 'public' });
    assert.deepEqual(JSON.parse(tables.content[0].text), { tables: [{ name: 't1', type: 'BASE TABLE' }] });

    stub.userResult = {
        fields: [],
        rows: [{ column_name: 'id', data_type: 'uuid', is_nullable: 'NO', column_default: null, ordinal_position: 1 }],
        rowCount: 1,
        command: 'SELECT',
    };
    const cols = await fake.tools.get('describe_table')!.handler({ datasource: 'main', schema: 'public', table: 't1' });
    assert.deepEqual(JSON.parse(cols.content[0].text), {
        columns: [{ name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 }],
    });
});

// ── list_datasources ────────────────────────────────────────────────────────────

const baseDs = makeConfig().datasources[0];
/** Vary one datasource off the shared fixture (which is `writable: true`). */
function ds(name: string, over: Partial<DatasourceConfig> = {}): DatasourceConfig {
    return { ...baseDs, name, ...over };
}

/**
 * Three datasources spanning both `writable` values, and two tokens with different
 * grant widths. A single-datasource fixture would let a payload that hard-codes
 * `writable: true` — or ignores caps entirely — pass every assertion below.
 */
function multiConfig(): RootConfig {
    return makeConfig({
        datasources: [ds('main'), ds('warehouse', { defaultSchema: 'analytics', writable: false }), ds('vault', { defaultSchema: 'secrets', writable: false })],
        tokens: [
            { id: 'agent_ro', secret: 'ro-secret', datasources: ['main', 'warehouse'], mode: 'read', schemas: ['*'] },
            { id: 'scoped', secret: 'scoped-secret', datasources: ['warehouse'], mode: 'read', schemas: ['*'] },
        ],
    });
}

/** Register the tools under the caps a real bearer token resolves to — the same
 *  identity the HTTP path authenticates, so parity assertions compare like with like. */
function setupAs(secret: string, config: RootConfig = multiConfig()) {
    const services = buildServices(config, silentLogger, new StubDriver());
    const caps = services.auth.authenticate(`Bearer ${secret}`);
    assert.ok(caps, `token "${secret}" did not authenticate`);
    const fake = new FakeMcp();
    registerTools(fake as never, services, caps);
    return { services, fake, caps };
}

async function listDatasources(fake: FakeMcp): Promise<{ name: string; defaultSchema: string; writable: boolean }[]> {
    const res = await fake.tools.get('list_datasources')!.handler({});
    assert.notEqual(res.isError, true, res.content[0]?.text);
    return JSON.parse(res.content[0].text).datasources;
}

test('list_datasources returns {name, defaultSchema, writable} for each permitted datasource', async () => {
    const { fake } = setupAs('ro-secret');
    assert.deepEqual(await listDatasources(fake), [
        { name: 'main', defaultSchema: 'public', writable: true },
        { name: 'warehouse', defaultSchema: 'analytics', writable: false },
    ]);
});

test('SECURITY: list_datasources is filtered by caps — a token cannot enumerate datasources outside its allow-list', async () => {
    const { fake } = setupAs('scoped-secret'); // granted ['warehouse'] only
    const res = await fake.tools.get('list_datasources')!.handler({});
    assert.deepEqual(JSON.parse(res.content[0].text), { datasources: [{ name: 'warehouse', defaultSchema: 'analytics', writable: false }] });
    // Not even as a substring: the ungranted names must never reach the model.
    assert.ok(!res.content[0].text.includes('vault'));
    assert.ok(!res.content[0].text.includes('main'));
});

test('list_datasources reflects a reload without the server being rebuilt', async () => {
    const { services, fake, caps } = setupAs('ro-secret'); // granted ['main','warehouse']
    assert.deepEqual((await listDatasources(fake)).map((d) => d.name), ['main', 'warehouse']);

    // Simulate a reload, both halves of it. PoolManager is mutated in place (design
    // decision 5) and the live caps object is refreshed with Object.assign (the stdio
    // identity-refresh path) — the tools keep the `Services`/`caps` references they
    // captured at registration. A handler that snapshotted names, configs, or the
    // filtered list at registration would miss this entirely.
    const added = ds('reports', { defaultSchema: 'rpt', writable: false });
    const names = services.pools.names.bind(services.pools);
    const getConfig = services.pools.getConfig.bind(services.pools);
    services.pools.names = (): string[] => [...names(), 'reports'];
    services.pools.getConfig = (n: string): DatasourceConfig => (n === 'reports' ? added : getConfig(n));
    Object.assign(caps, { datasources: ['main', 'warehouse', 'reports'] });

    assert.deepEqual(await listDatasources(fake), [
        { name: 'main', defaultSchema: 'public', writable: true },
        { name: 'warehouse', defaultSchema: 'analytics', writable: false },
        { name: 'reports', defaultSchema: 'rpt', writable: false },
    ]);
    // `vault` is in the pool set the whole time and never granted — a reload widens
    // what is visible, it must not bypass the caps filter.
});

test('buildInstructions no longer enumerates datasource names', () => {
    // The names ARE reachable here (caps carries them), so the assertion has teeth:
    // it fails the moment someone re-inlines a list that a reload would make stale.
    const caps: Capabilities = { id: 'agent_ro', datasources: ['warehouse_alpha', 'vault_beta'], canWrite: false, schemas: ['*'] };
    const text = buildInstructions(caps);
    assert.ok(!text.includes('warehouse_alpha'), 'instructions enumerate a datasource name');
    assert.ok(!text.includes('vault_beta'), 'instructions enumerate a datasource name');
    assert.match(text, /list_datasources/); // …and point at the always-current source instead
});

test('list_datasources and GET /datasources return the same shape for the same token', async () => {
    const { services, fake } = setupAs('ro-secret');
    const app = buildApp(services);
    await app.ready();
    try {
        const viaMcp = await listDatasources(fake);
        const viaHttp = await app.inject({ method: 'GET', url: '/datasources', headers: { authorization: 'Bearer ro-secret' } });
        assert.equal(viaHttp.statusCode, 200);
        // The envelope differs by transport on purpose (MCP tools return an object, the
        // route a bare array); the ELEMENT shape must not. Structural deep-equal, so a
        // field added to one transport and not the other fails here.
        assert.deepEqual(viaMcp, viaHttp.json());
        // Guard against a vacuous pass: the compared payload must actually span both
        // `writable` values and more than one datasource.
        assert.ok(viaMcp.length > 1 && viaMcp.some((d) => d.writable) && viaMcp.some((d) => !d.writable));
    } finally {
        await app.close();
    }
});
