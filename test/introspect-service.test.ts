import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolManager } from '../src/pool/pool-manager.js';
import { QueryService } from '../src/query/query-service.js';
import { IntrospectService } from '../src/introspect/introspect-service.js';
import type { Capabilities } from '../src/auth/token-auth.js';
import { makeConfig, silentLogger, StubDriver, CapturingAudit } from './helpers.js';

const config = makeConfig();
const pools = new PoolManager(config.datasources, silentLogger);
after(() => pools.drainAll());

function build(stub: StubDriver) {
    const qs = new QueryService(stub, pools, config.maxRowsCeiling, new CapturingAudit());
    return new IntrospectService(qs, pools);
}

const wildcard: Capabilities = { id: 'agent_ro', datasources: ['main'], canWrite: false, schemas: ['*'] };
const scoped: Capabilities = { id: 'scoped', datasources: ['main'], canWrite: false, schemas: ['public'] };

test('listSchemas excludes system schemas and applies wildcard caps', async () => {
    const stub = new StubDriver();
    stub.userResult = {
        fields: [],
        rows: [{ schema_name: 'public' }, { schema_name: 'pg_catalog' }, { schema_name: 'information_schema' }, { schema_name: 'tenant_a' }],
        rowCount: 4,
        command: 'SELECT',
    };
    const introspect = build(stub);
    const schemas = await introspect.listSchemas(wildcard, 'main');
    assert.deepEqual(schemas, ['public', 'tenant_a']);
    assert.match(stub.userStatements()[0].sql, /information_schema\.schemata/);
});

test('listSchemas filters to the token capability list', async () => {
    const stub = new StubDriver();
    stub.userResult = {
        fields: [],
        rows: [{ schema_name: 'public' }, { schema_name: 'tenant_a' }, { schema_name: 'tenant_b' }],
        rowCount: 3,
        command: 'SELECT',
    };
    const schemas = await build(stub).listSchemas(scoped, 'main');
    assert.deepEqual(schemas, ['public']);
});

test('listTables uses information_schema.tables with the schema param', async () => {
    const stub = new StubDriver();
    stub.userResult = {
        fields: [],
        rows: [
            { table_name: 't1', table_type: 'BASE TABLE' },
            { table_name: 'v1', table_type: 'VIEW' },
        ],
        rowCount: 2,
        command: 'SELECT',
    };
    const tables = await build(stub).listTables('t', 'main', 'public');
    assert.deepEqual(tables, [
        { name: 't1', type: 'BASE TABLE' },
        { name: 'v1', type: 'VIEW' },
    ]);
    const call = stub.userStatements()[0];
    assert.match(call.sql, /information_schema\.tables/);
    assert.deepEqual(call.params, ['public']);
});

test('describeTable returns ordered typed columns with params [schema, table]', async () => {
    const stub = new StubDriver();
    stub.userResult = {
        fields: [],
        rows: [
            { column_name: 'id', data_type: 'uuid', is_nullable: 'NO', column_default: null, ordinal_position: 1 },
            { column_name: 'name', data_type: 'text', is_nullable: 'YES', column_default: "'x'::text", ordinal_position: 2 },
        ],
        rowCount: 2,
        command: 'SELECT',
    };
    const cols = await build(stub).describeTable('t', 'main', 'public', 'accounts');
    assert.deepEqual(cols, [
        { name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 },
        { name: 'name', dataType: 'text', nullable: true, default: "'x'::text", position: 2 },
    ]);
    const call = stub.userStatements()[0];
    assert.match(call.sql, /information_schema\.columns/);
    assert.match(call.sql, /ORDER BY ordinal_position/);
    assert.deepEqual(call.params, ['public', 'accounts']);
});
