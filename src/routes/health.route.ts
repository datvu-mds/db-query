/**
 * GET /health — unauthenticated liveness/readiness. Uses the cached HealthChecker
 * (not a fresh ping per request) so probe floods can't exhaust the pool. Returns
 * 200 only when all datasources answer, otherwise 503 (degraded).
 */
import type { FastifyInstance } from 'fastify';
import type { Services } from '../services.js';

export function registerHealthRoute(app: FastifyInstance, s: Services): void {
    app.get('/health', async (_request, reply) => {
        const datasources = await Promise.all(
            s.pools.names().map(async (name) => ({
                name,
                ok: await s.health.check(name),
                poolSize: s.pools.poolSize(name),
            })),
        );
        const ok = datasources.every((d) => d.ok);
        return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', datasources });
    });
}
