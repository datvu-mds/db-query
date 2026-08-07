/**
 * MCP tool definitions — thin wrappers over the SAME QueryService / IntrospectService
 * used by the HTTP path. ZERO business logic here: all guardrails (read-only txn,
 * tenant SET LOCAL, timeouts, audit) and authorization live in the services and
 * apply unchanged. The process runs as ONE identity (the MCP_TOKEN capabilities),
 * so every tool authorizes against those caps before touching a service.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../services.js';
import type { Capabilities } from '../auth/token-auth.js';

interface ToolResult {
    // Index signature matches the SDK's CallToolResult (a passthrough object).
    [k: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

function ok(data: unknown): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

/** Authorize datasource (+ optional schema + write) against caps; return the
 *  effective schema or throw with the denial reason. Mirrors the HTTP route guards. */
function authorize(s: Services, caps: Capabilities, datasource: string, schema: string | undefined, writeRequested: boolean): string {
    if (!s.auth.datasourceAllowed(caps, datasource)) throw new Error(`datasource "${datasource}" not permitted`);
    if (!s.pools.names().includes(datasource)) throw new Error(`unknown datasource "${datasource}"`);
    const effective = schema ?? s.pools.getConfig(datasource).defaultSchema;
    const authz = s.auth.authorize(caps, { datasource, schema: effective, writeRequested });
    if (!authz.ok) throw new Error(authz.reason);
    return effective;
}

export function registerTools(server: McpServer, s: Services, caps: Capabilities): void {
    server.registerTool(
        'run_query',
        {
            title: 'Run a SQL query',
            description:
                'Execute ONE SQL statement against a logical datasource and return neutral ' +
                '{columns,rows,rowCount,truncated,elapsedMs}. Read-only by default; set readOnly:false ' +
                'only with a write-capable token. schema defaults to the datasource default — pass a ' +
                'tenant/account-UUID schema to target a specific tenant. Use $1,$2… params, never inline values. ' +
                'Catalog/information_schema relations and some sensitive tables are blocked — use ' +
                'list_schemas/list_tables/describe_table for structure.',
            inputSchema: {
                datasource: z.string().describe('Logical datasource name'),
                schema: z.string().optional().describe('Target schema (tenant/account UUID); omit for datasource default'),
                sql: z.string().describe('A single SQL statement'),
                params: z.array(z.unknown()).optional().describe('Positional parameter values for $1,$2…'),
                readOnly: z.boolean().optional().describe('Default true; false requires a write-capable token'),
                maxRows: z.number().optional().describe('Row cap (clamped to the server ceiling)'),
                timeoutMs: z.number().optional().describe('Statement timeout ms (clamped to the datasource max)'),
            },
        },
        async (args) => {
            try {
                const writeRequested = args.readOnly === false;
                const schema = authorize(s, caps, args.datasource, args.schema, writeRequested);
                const { response } = await s.queryService.run({
                    tokenId: caps.id,
                    datasource: args.datasource,
                    schema,
                    sql: args.sql,
                    params: args.params,
                    write: writeRequested,
                    maxRows: args.maxRows,
                    timeoutMs: args.timeoutMs,
                    allowedSchemas: caps.schemas,
                });
                return ok(response);
            } catch (e) {
                return fail((e as Error).message);
            }
        },
    );

    server.registerTool(
        'list_schemas',
        {
            title: 'List schemas',
            description: 'List schemas visible to this token in a datasource (excludes system schemas; filtered by token caps).',
            inputSchema: { datasource: z.string().describe('Logical datasource name') },
        },
        async (args) => {
            try {
                if (!s.auth.datasourceAllowed(caps, args.datasource)) throw new Error(`datasource "${args.datasource}" not permitted`);
                if (!s.pools.names().includes(args.datasource)) throw new Error(`unknown datasource "${args.datasource}"`);
                return ok({ schemas: await s.introspectService.listSchemas(caps, args.datasource) });
            } catch (e) {
                return fail((e as Error).message);
            }
        },
    );

    server.registerTool(
        'list_tables',
        {
            title: 'List tables',
            description: 'List base tables and views in a datasource schema.',
            inputSchema: {
                datasource: z.string().describe('Logical datasource name'),
                schema: z.string().describe('Schema to list (tenant/account UUID or e.g. public)'),
            },
        },
        async (args) => {
            try {
                const schema = authorize(s, caps, args.datasource, args.schema, false);
                return ok({ tables: await s.introspectService.listTables(caps.id, args.datasource, schema) });
            } catch (e) {
                return fail((e as Error).message);
            }
        },
    );

    server.registerTool(
        'describe_table',
        {
            title: 'Describe table',
            description: 'List columns (name, dataType, nullable, default, position) of a table.',
            inputSchema: {
                datasource: z.string().describe('Logical datasource name'),
                schema: z.string().describe('Schema of the table'),
                table: z.string().describe('Table name'),
            },
        },
        async (args) => {
            try {
                const schema = authorize(s, caps, args.datasource, args.schema, false);
                return ok({ columns: await s.introspectService.describeTable(caps.id, args.datasource, schema, args.table) });
            } catch (e) {
                return fail((e as Error).message);
            }
        },
    );
}
