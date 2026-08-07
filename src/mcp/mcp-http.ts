/**
 * Streamable-HTTP transport for the MCP adapter (opt-in via MCP_TRANSPORT=http).
 * Uses Node's built-in http + the SDK's
 * StreamableHTTPServerTransport, one isolated McpServer per session. Binds to
 * loopback by default — this is a trusted-infra utility, never expose publicly.
 *
 * Identity is process-level (the MCP_TOKEN caps), same as stdio. Over HTTP we
 * additionally REQUIRE the caller to present that same token as a bearer, and
 * enable the SDK's DNS-rebinding protection (Host allow-list) — so a malicious web
 * page can't rebind to loopback and drive tools it never authenticated for.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Services } from '../services.js';
import type { Capabilities } from '../auth/token-auth.js';
import { createMcpServer } from './create-mcp-server.js';
import { assertBindAllowed } from '../config/bind-guard.js';

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024; // small JSON-RPC messages

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
                req.destroy();
                reject(new Error('Request body too large'));
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (chunks.length === 0) return resolve(undefined);
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new Error('Parse error'));
            }
        });
        req.on('error', reject);
    });
}

function sendRpcError(res: ServerResponse, status: number, code: number, message: string, id: unknown = null): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id }));
}

/** Require the caller to present the SAME token this process runs as (caps.id). */
function authorized(services: Services, caps: Capabilities, req: IncomingMessage): boolean {
    const h = req.headers['authorization'];
    const value = Array.isArray(h) ? h[0] : h;
    return services.auth.authenticate(value)?.id === caps.id;
}

/** `??` only defaults on undefined, but a blank `.env` line yields '' — and an empty
 *  host makes Node bind EVERY interface. Treat empty/whitespace as absent, the same
 *  normalisation load-config applies to HOST/PORT (these two env vars bypass zod). */
function envOr(name: string, fallback: string): string {
    const raw = process.env[name];
    return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

export function startMcpHttp(services: Services, caps: Capabilities): void {
    const port = Number(envOr('MCP_HTTP_PORT', '3201'));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`MCP_HTTP_PORT must be a valid port number (got "${process.env.MCP_HTTP_PORT}")`);
    }
    const host = envOr('MCP_HTTP_HOST', '127.0.0.1');
    // A non-loopback MCP_HTTP_HOST would also weaken the allowedHosts rebinding
    // defence below, since the Host header would then legitimately vary. Refuse it
    // unless the operator opted in explicitly.
    assertBindAllowed(host, 'MCP streamable-HTTP transport');
    // Host allow-list for DNS-rebinding protection (the SDK checks the Host header).
    const allowedHosts = [`${host}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`];
    const transports = new Map<string, StreamableHTTPServerTransport>();

    const httpServer = createHttpServer(async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (pathname !== MCP_PATH) {
            sendRpcError(res, 404, -32601, 'Not found');
            return;
        }
        // Bearer required — same identity the process runs as. Rejects unauthenticated
        // and DNS-rebind/SSRF callers that can't supply the token.
        if (!authorized(services, caps, req)) {
            sendRpcError(res, 401, -32001, 'Unauthorized');
            return;
        }
        const header = req.headers['mcp-session-id'];
        const sessionId = Array.isArray(header) ? header[0] : header;
        const existing = sessionId ? transports.get(sessionId) : undefined;

        try {
            if (req.method === 'POST') {
                const body = await readJsonBody(req, MAX_BODY_BYTES);
                let transport = existing;
                if (!transport) {
                    const id = (body as { id?: unknown } | undefined)?.id ?? null;
                    if (sessionId) return sendRpcError(res, 404, -32001, 'Session not found', id);
                    if (!isInitializeRequest(body)) return sendRpcError(res, 400, -32000, 'Bad Request: No valid session ID', id);
                    // Explicit type: closures below reference `created` in its own initializer.
                    const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => randomUUID(),
                        enableDnsRebindingProtection: true,
                        allowedHosts,
                        onsessioninitialized: (sid: string): void => {
                            transports.set(sid, created);
                        },
                    });
                    created.onclose = (): void => {
                        if (created.sessionId) transports.delete(created.sessionId);
                    };
                    await createMcpServer(services, caps).connect(created);
                    transport = created;
                }
                await transport.handleRequest(req, res, body);
                return;
            }
            if (req.method === 'GET' || req.method === 'DELETE') {
                if (!existing) return sendRpcError(res, 404, -32001, 'Session not found');
                await existing.handleRequest(req, res);
                return;
            }
            sendRpcError(res, 405, -32000, 'Method not allowed');
        } catch (err) {
            if (!res.headersSent) sendRpcError(res, 500, -32603, (err as Error).message);
        }
    });

    httpServer.on('error', (err) => {
        console.error('[pg-connection-pool-mcp] http server error (fatal):', err);
        process.exit(1);
    });

    httpServer.listen(port, host, () => {
        console.error(`[pg-connection-pool-mcp] streamable-HTTP listening on http://${host}:${port}${MCP_PATH}`);
    });
}
