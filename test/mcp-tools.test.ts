import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServices } from '../src/services.js';
import { registerTools } from '../src/mcp/tools.js';
import type { Capabilities } from '../src/auth/token-auth.js';
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

test('registers exactly the 4 tools', () => {
    const stub = new StubDriver();
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);
    assert.deepEqual([...fake.tools.keys()].sort(), ['describe_table', 'list_schemas', 'list_tables', 'run_query']);
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
