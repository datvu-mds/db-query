/**
 * createMcpServer — build one McpServer with the 5 tools registered against the
 * shared services + resolved identity. A single server suffices (the 5 tools are
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
 * duplicated into each project's CLAUDE.md.
 *
 * It deliberately does NOT enumerate datasource names, even though `caps` carries
 * them. A client caches instructions from the initialize response, so any name
 * listed here is frozen at that moment — a config reload that adds or removes a
 * datasource would leave the agent working from a list the server no longer
 * honours. `list_datasources` is read live per call, so it is always current.
 *
 * The staleness is STDIO-SPECIFIC: mcp-http.ts:119 builds a new McpServer per
 * session, so any streamable-HTTP session opened after a reload already gets
 * freshly-built instructions. Only stdio holds one long-lived server whose
 * instructions were built once at boot. Stated because it reads like a general
 * problem and is not.
 *
 * Exported for test/mcp-tools.test.ts — reading instructions back off a
 * constructed McpServer means poking at SDK internals.
 */
export function buildInstructions(caps: Capabilities): string {
    const writeNote = caps.canWrite
        ? 'This identity CAN write: pass readOnly:false to run a write (it defaults to read-only otherwise, ' +
          'and a datasource marked writable:false rejects the write anyway).'
        : 'This identity is READ-ONLY: writes are rejected before any DB contact.';
    return [
        'Postgres query gateway. Prefer these tools over ad-hoc psql for ANY database read',
        '(debugging, inspecting schema, reproducing data) — every call runs under guardrails and audit.',
        'Call list_datasources first for the datasources you may use (names can change at runtime, so they',
        'are NOT listed here). Pass `datasource` on every call.',
        'Discover structure first: list_schemas → list_tables → describe_table.',
        '`schema` is a tenant/account-UUID (schema-per-tenant); omit it to use the datasource default.',
        'run_query runs exactly ONE statement. Pass values as $1,$2… via `params` — NEVER inline literals',
        '(SQL text is audit-logged; params are not).',
        writeNote,
    ].join('\n');
}

export function createMcpServer(services: Services, caps: Capabilities): McpServer {
    const server = new McpServer({ name: 'pg-connection-pool', version: '0.1.0' }, { instructions: buildInstructions(caps) });
    registerTools(server, services, caps);
    return server;
}
