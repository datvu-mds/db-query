/**
 * buildApp — assemble the Fastify instance and register every route against the
 * shared services. Kept separate from server.ts so tests can `app.inject(...)`
 * without binding a port or installing signal handlers.
 */
import Fastify from 'fastify';
import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { Services } from './services.js';
import { registerQueryRoute } from './routes/query.route.js';
import { registerHealthRoute } from './routes/health.route.js';
import { registerDatasourcesRoute } from './routes/datasources.route.js';
import { registerIntrospectRoutes } from './routes/introspect.route.js';

export function buildApp(services: Services): FastifyInstance {
    // Cast to FastifyBaseLogger so the instance keeps Fastify's default generics
    // (pino's Logger type would otherwise re-parameterize FastifyInstance and clash
    // with the route-registration functions' default-generic parameter type).
    const app = Fastify({ loggerInstance: services.logger as unknown as FastifyBaseLogger });

    registerHealthRoute(app, services);
    registerDatasourcesRoute(app, services);
    registerQueryRoute(app, services);
    registerIntrospectRoutes(app, services);

    return app;
}
