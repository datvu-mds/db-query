/**
 * GET /datasources — list the datasources this token may use (filtered by caps,
 * so a token can't enumerate datasources outside its allow-list).
 */
import type { FastifyInstance } from 'fastify';
import type { Services } from '../services.js';

export function registerDatasourcesRoute(app: FastifyInstance, s: Services): void {
    app.get('/datasources', async (request, reply) => {
        const caps = s.auth.authenticate(request.headers.authorization);
        if (!caps) return reply.code(401).send({ error: 'unauthorized' });

        // Element shape is deliberately identical to the MCP `list_datasources` tool
        // (mcp/tools.ts); only the envelope differs (bare array here, {datasources:[…]}
        // there), and test/mcp-tools.test.ts asserts the two equal so they cannot drift.
        // `writable` travels with the listing so a caller knows whether a write is even
        // possible before attempting one.
        const list = s.pools
            .names()
            .filter((name) => s.auth.datasourceAllowed(caps, name))
            .map((name) => {
                const cfg = s.pools.getConfig(name);
                return { name, defaultSchema: cfg.defaultSchema, writable: cfg.writable };
            });

        return reply.code(200).send(list);
    });
}
