/**
 * TokenAuth — maps a bearer secret to a capability set and authorizes each
 * request against it. All checks happen BEFORE any DB contact.
 *
 * Secrets are compared in constant time: we keep a SHA-256 digest of each
 * configured secret and `timingSafeEqual` it against the digest of the presented
 * secret (fixed length, so no length-leak and no throw). The digest, not the raw
 * secret, also means the process never keeps the plaintext around for comparison.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { TokenConfig } from '../config/config.schema.js';

export interface Capabilities {
    id: string;
    datasources: string[]; // ['*'] = all
    canWrite: boolean;
    schemas: string[]; // ['*'] = any non-system schema
}

export type AuthzResult = { ok: true } | { ok: false; status: number; reason: string };

interface TokenEntry {
    digest: Buffer;
    caps: Capabilities;
}

function sha256(s: string): Buffer {
    return createHash('sha256').update(s).digest();
}

/** '*' wildcard or explicit membership — the ONE definition of a caps match, shared
 *  by authorize() below and the relation guard's cross-schema check so the two
 *  cannot drift. */
export function capabilityAllows(list: string[], value: string): boolean {
    return list.includes('*') || list.includes(value);
}

export class TokenAuth {
    private readonly entries: TokenEntry[];

    constructor(tokens: TokenConfig[]) {
        this.entries = tokens.map((t) => ({
            digest: sha256(t.secret),
            caps: {
                id: t.id,
                datasources: t.datasources,
                canWrite: t.mode === 'write',
                schemas: t.schemas,
            },
        }));
    }

    private parseBearer(header?: string): string | null {
        if (!header) return null;
        const m = /^Bearer\s+(.+)$/i.exec(header.trim());
        return m ? m[1].trim() : null;
    }

    /** Resolve a bearer header to capabilities, or null (→ 401). */
    authenticate(header?: string): Capabilities | null {
        const secret = this.parseBearer(header);
        if (!secret) return null;
        const presented = sha256(secret);
        // Scan ALL entries (no early return) so match position can't be timed.
        let matched: TokenEntry | null = null;
        for (const entry of this.entries) {
            if (timingSafeEqual(entry.digest, presented)) matched = entry;
        }
        return matched ? matched.caps : null;
    }

    datasourceAllowed(caps: Capabilities, datasource: string): boolean {
        return capabilityAllows(caps.datasources, datasource);
    }

    /**
     * Full authorization for a resolved request. Order matters: datasource
     * membership is checked before anything else so an unauthorized token cannot
     * distinguish "forbidden" from "does not exist" (no enumeration leak).
     */
    authorize(caps: Capabilities, req: { datasource: string; schema: string; writeRequested: boolean }): AuthzResult {
        if (!capabilityAllows(caps.datasources, req.datasource)) {
            return { ok: false, status: 403, reason: `datasource "${req.datasource}" not permitted` };
        }
        if (!capabilityAllows(caps.schemas, req.schema)) {
            return { ok: false, status: 403, reason: `schema "${req.schema}" not permitted` };
        }
        // Double gate: writing requires a write-capable token AND explicit readOnly:false.
        if (req.writeRequested && !caps.canWrite) {
            return { ok: false, status: 403, reason: 'write-not-permitted' };
        }
        return { ok: true };
    }
}
