/**
 * POST /query — auth → validate → authorize → QueryService.
 *
 * The effective schema (request or datasource default) is what gets authorized
 * and applied. Auditing happens inside QueryService, so this handler only maps
 * success/failure to HTTP status.
 */
import type { FastifyInstance } from 'fastify';
import type { Services } from '../services.js';
import { queryRequestSchema } from '../query/query.schema.js';
import { statusOf } from '../query/gateway-errors.js';
import { redactErrorMessage } from '../query/redact-error.js';
import { authenticate, parseBody, datasourceReady } from './route-helpers.js';

export function registerQueryRoute(app: FastifyInstance, s: Services): void {
    app.post('/query', async (request, reply) => {
        const caps = authenticate(s, request, reply);
        if (!caps) return;
        const body = parseBody(queryRequestSchema, request, reply);
        if (!body) return;
        if (!datasourceReady(s, caps, body.datasource, reply)) return;

        const schema = body.schema ?? s.pools.getConfig(body.datasource).defaultSchema;
        const writeRequested = body.readOnly === false; // double gate: also needs canWrite
        const authz = s.auth.authorize(caps, { datasource: body.datasource, schema, writeRequested });
        if (!authz.ok) return reply.code(authz.status).send({ error: authz.reason });

        try {
            const { response } = await s.queryService.run({
                tokenId: caps.id,
                datasource: body.datasource,
                schema,
                sql: body.sql,
                params: body.params,
                write: writeRequested,
                maxRows: body.maxRows,
                timeoutMs: body.timeoutMs,
                allowedSchemas: caps.schemas,
            });
            return reply.code(200).send(response);
        } catch (err) {
            return reply.code(statusOf(err)).send({ error: redactErrorMessage(err) });
        }
    });
}
