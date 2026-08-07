/**
 * Introspection routes — /introspect/schemas | /tables | /describe. Each guards
 * auth + validation + datasource, authorizes the target schema (tables/describe),
 * then delegates to IntrospectService (which runs through the guarded read-only
 * QueryService path). Error→status mapping only; audit is done in QueryService.
 */
import type { FastifyInstance } from 'fastify';
import type { Services } from '../services.js';
import { schemasRequestSchema, tablesRequestSchema, describeRequestSchema } from '../introspect/introspect.schema.js';
import { statusOf } from '../query/gateway-errors.js';
import { authenticate, parseBody, datasourceReady } from './route-helpers.js';

export function registerIntrospectRoutes(app: FastifyInstance, s: Services): void {
    app.post('/introspect/schemas', async (request, reply) => {
        const caps = authenticate(s, request, reply);
        if (!caps) return;
        const body = parseBody(schemasRequestSchema, request, reply);
        if (!body) return;
        if (!datasourceReady(s, caps, body.datasource, reply)) return;
        try {
            const schemas = await s.introspectService.listSchemas(caps, body.datasource);
            return reply.code(200).send({ schemas });
        } catch (err) {
            return reply.code(statusOf(err)).send({ error: (err as Error).message });
        }
    });

    app.post('/introspect/tables', async (request, reply) => {
        const caps = authenticate(s, request, reply);
        if (!caps) return;
        const body = parseBody(tablesRequestSchema, request, reply);
        if (!body) return;
        if (!datasourceReady(s, caps, body.datasource, reply)) return;
        const authz = s.auth.authorize(caps, { datasource: body.datasource, schema: body.schema, writeRequested: false });
        if (!authz.ok) return reply.code(authz.status).send({ error: authz.reason });
        try {
            const tables = await s.introspectService.listTables(caps.id, body.datasource, body.schema);
            return reply.code(200).send({ tables });
        } catch (err) {
            return reply.code(statusOf(err)).send({ error: (err as Error).message });
        }
    });

    app.post('/introspect/describe', async (request, reply) => {
        const caps = authenticate(s, request, reply);
        if (!caps) return;
        const body = parseBody(describeRequestSchema, request, reply);
        if (!body) return;
        if (!datasourceReady(s, caps, body.datasource, reply)) return;
        const authz = s.auth.authorize(caps, { datasource: body.datasource, schema: body.schema, writeRequested: false });
        if (!authz.ok) return reply.code(authz.status).send({ error: authz.reason });
        try {
            const columns = await s.introspectService.describeTable(caps.id, body.datasource, body.schema, body.table);
            return reply.code(200).send({ columns });
        } catch (err) {
            return reply.code(statusOf(err)).send({ error: (err as Error).message });
        }
    });
}
