/**
 * Shared route guards. Each returns the resolved value on success, or sends the
 * appropriate error reply and returns null — the handler then simply `return`s.
 * Centralizing these keeps auth/validation/datasource behavior identical across
 * /query and /introspect/*.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeAny } from 'zod';
import type { Services } from '../services.js';
import type { Capabilities } from '../auth/token-auth.js';

export function authenticate(s: Services, request: FastifyRequest, reply: FastifyReply): Capabilities | null {
    const caps = s.auth.authenticate(request.headers.authorization);
    if (!caps) {
        reply.code(401).send({ error: 'unauthorized' });
        return null;
    }
    return caps;
}

export function parseBody<S extends ZodTypeAny>(schema: S, request: FastifyRequest, reply: FastifyReply): S['_output'] | null {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
        reply.code(400).send({ error: 'invalid request', details: parsed.error.issues });
        return null;
    }
    return parsed.data;
}

/** Authorize datasource membership (403) BEFORE existence (400) — no enumeration leak. */
export function datasourceReady(s: Services, caps: Capabilities, datasource: string, reply: FastifyReply): boolean {
    if (!s.auth.datasourceAllowed(caps, datasource)) {
        reply.code(403).send({ error: `datasource "${datasource}" not permitted` });
        return false;
    }
    if (!s.pools.names().includes(datasource)) {
        reply.code(400).send({ error: `unknown datasource "${datasource}"` });
        return false;
    }
    return true;
}
