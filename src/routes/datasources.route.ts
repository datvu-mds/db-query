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

        const list = s.pools
            .names()
            .filter((name) => s.auth.datasourceAllowed(caps, name))
            .map((name) => ({ name, defaultSchema: s.pools.getConfig(name).defaultSchema }));

        return reply.code(200).send(list);
    });
}
