/**
 * createMcpServer — build one McpServer with the 4 tools registered against the
 * shared services + resolved identity. A single server suffices (the 4 tools are
 * static; no per-session state). The HTTP transport still builds one per session
 * because the SDK binds a server to exactly one transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../services.js';
import type { Capabilities } from '../auth/token-auth.js';
import { registerTools } from './tools.js';

/**
 * Server-level usage guidance. MCP clients (e.g. Claude Code) surface this in the
 * agent's system prompt, so it travels WITH the server to every project that
 * registers it — the single, DRY home for "how to use this", instead of a rule
 * duplicated into each project's CLAUDE.md. Derived from the live identity so the
 * datasource list and read/write posture are accurate, not aspirational.
 */
function buildInstructions(services: Services, caps: Capabilities): string {
    const all = services.pools.names();
    const usable = caps.datasources.includes('*') ? all : all.filter((n) => caps.datasources.includes(n));
    const dsList = usable.length ? usable.join(', ') : '(none configured)';
    const writeNote = caps.canWrite
        ? 'This identity CAN write: pass readOnly:false to run a write (it defaults to read-only otherwise).'
        : 'This identity is READ-ONLY: writes are rejected before any DB contact.';
    return [
        'Postgres query gateway. Prefer these tools over ad-hoc psql for ANY database read',
        '(debugging, inspecting schema, reproducing data) — every call runs under guardrails and audit.',
        `Datasources you may use: ${dsList}. Pass \`datasource\` on every call.`,
        'Discover structure first: list_schemas → list_tables → describe_table.',
        '`schema` is a tenant/account-UUID (schema-per-tenant); omit it to use the datasource default.',
        'run_query runs exactly ONE statement. Pass values as $1,$2… via `params` — NEVER inline literals',
        '(SQL text is audit-logged; params are not).',
        writeNote,
    ].join('\n');
}

export function createMcpServer(services: Services, caps: Capabilities): McpServer {
    const server = new McpServer({ name: 'pg-connection-pool', version: '0.1.0' }, { instructions: buildInstructions(services, caps) });
    registerTools(server, services, caps);
    return server;
}
