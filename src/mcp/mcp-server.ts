#!/usr/bin/env node
/**
 * MCP entrypoint. Loads the same config as the HTTP server, resolves the process
 * identity from MCP_TOKEN → capabilities, does a fail-fast boot ping, then serves
 * over stdio (default) or streamable HTTP (MCP_TRANSPORT=http). Shares the exact
 * QueryService/IntrospectService the HTTP server uses — no duplicated logic.
 *
 * All human-readable output goes to stderr: stdout carries the JSON-RPC stream.
 */
import pino from 'pino';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config/load-config.js';
import { buildServices } from '../services.js';
import { createMcpServer } from './create-mcp-server.js';
import { startMcpHttp } from './mcp-http.js';
import { assertReadOnlyPosture } from '../boot/assert-readonly-posture.js';

async function main(): Promise<void> {
    const config = loadConfig();
    // pino defaults to fd 1, which on the stdio transport IS the JSON-RPC channel —
    // an audit or pool-error line written there corrupts the stream. Pin the sink to
    // stderr (fd 2) so the "all human-readable output goes to stderr" rule above
    // holds for structured logs too, not just console.error.
    //
    // sync:true is required, not a preference: the default async sink buffers, and
    // the boot paths below log and then call process.exit() immediately, which would
    // drop the very diagnostic that explains the exit. It also stops async writes
    // interleaving mid-line with the console.error calls sharing this fd. stderr here
    // is a handful of lines per boot, so there is no throughput cost.
    const logger = pino({ level: config.logLevel }, pino.destination({ dest: 2, sync: true }));
    const services = buildServices(config, logger);

    // Process identity: the bearer secret this MCP server runs as.
    const token = process.env.MCP_TOKEN;
    if (!token) throw new Error('MCP_TOKEN env var is required (the bearer secret this MCP process runs as).');
    const caps = services.auth.authenticate(`Bearer ${token}`);
    if (!caps) throw new Error('MCP_TOKEN does not match any configured token.');

    // Fail-fast boot ping — refuse to start if a datasource is unreachable.
    for (const name of services.pools.names()) {
        try {
            await services.pools.ping(name);
        } catch (err) {
            console.error(`[pg-connection-pool-mcp] datasource "${name}" unreachable: ${(err as Error).message}`);
            await services.pools.drainAll();
            process.exit(1);
        }
    }

    // Reachability is proven; now state whether the DB itself is the read-only
    // backstop. Non-fatal by design (see assert-readonly-posture.ts).
    await assertReadOnlyPosture(services, caps.id);

    const shutdown = async (signal: string): Promise<void> => {
        console.error(`[pg-connection-pool-mcp] ${signal} — draining pools`);
        await services.pools.drainAll();
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    if (process.env.MCP_TRANSPORT === 'http') {
        startMcpHttp(services, caps);
        console.error(`[pg-connection-pool-mcp] ready (identity=${caps.id}) transport=http`);
        return;
    }

    const server = createMcpServer(services, caps);
    console.error(`[pg-connection-pool-mcp] ready (identity=${caps.id}) transport=stdio`);
    await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
    console.error(`[pg-connection-pool-mcp] fatal: ${(err as Error).message}`);
    process.exit(1);
});
