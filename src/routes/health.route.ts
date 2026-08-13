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
            s.pools.names().map(async (name) => {
                // Per-name try/catch, NOT a bare map. `check()` awaits a real ping on a
                // cache miss, and a concurrent reload can retire this datasource during
                // that await — `poolSize()` then throws a plain Error, `Promise.all`
                // rejects, and Fastify's default handler turns the WHOLE unauthenticated
                // endpoint into a 500. A liveness probe reads that as "process dead" and
                // restarts the container over one datasource that was deliberately
                // removed. Degraded is the honest answer for one entry; 500 for all of
                // them is not. (Reload made this reachable: before it, a datasource was
                // never removed at runtime.)
                try {
                    const ok = await s.health.check(name);
                    return { name, ok, poolSize: s.pools.poolSize(name) };
                } catch {
                    return { name, ok: false, poolSize: 0 };
                }
            }),
        );
        const ok = datasources.every((d) => d.ok);
        return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', datasources });
    });
}
