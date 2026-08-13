/**
 * TokenAuth — maps a bearer secret to a capability set and authorizes each
 * request against it. All checks happen BEFORE any DB contact.
 *
 * Secrets are compared in constant time: we keep a SHA-256 digest of each
 * configured secret and `timingSafeEqual` it against the digest of the presented
 * secret (fixed length, so no length-leak and no throw). The digest, not the raw
 * secret, also means the process never keeps the plaintext around for comparison.
 *
 * The token set is swappable at runtime (`applyTokens`, config reload). The swap
 * mutates this instance in place — see the `entries` note below for why a fresh
 * instance would be invisible to the consumers that matter.
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
    /**
     * Mutated IN PLACE by applyTokens, never reassigned — hence still `readonly`.
     * Routes and MCP tools capture the `Services` (and so this TokenAuth) reference at
     * registration and never re-read it, so a replacement instance would be invisible
     * to every consumer that matters; the array identity is held to the same rule so
     * nothing can hand out a stale view of the token set.
     */
    private readonly entries: TokenEntry[] = [];

    constructor(tokens: TokenConfig[]) {
        // Boot and reload build digests through the ONE mapping below. Duplicating it
        // here is how the two paths would drift — e.g. a future change hashing with a
        // salt on one path only.
        this.applyTokens(tokens);
    }

    /**
     * Replace the whole token set — the config-reload path (SIGHUP).
     *
     * Deliberately NOT guarded against an empty `next`: zero entries means zero digest
     * matches means 401 for everyone, which is the fail-CLOSED direction. A well-meaning
     * `if (!next.length) return;` would instead leave the previous grants live after the
     * operator emptied them — a revocation that silently did nothing.
     *
     * `next` itself is never retained: only the digest + derived caps survive this call,
     * so a reload cannot leave plaintext secrets reachable in the heap for the process
     * lifetime (the same reason the constructor never kept its argument).
     */
    applyTokens(next: TokenConfig[]): void {
        const rebuilt = next.map((t) => ({
            digest: sha256(t.secret),
            caps: {
                id: t.id,
                datasources: t.datasources,
                canWrite: t.mode === 'write',
                schemas: t.schemas,
            },
        }));
        // Build first, then swap in a single splice: nothing observes a half-applied
        // token set, and a throw while hashing leaves the running grants untouched.
        // (Both this and authenticate() are synchronous, so no scan can interleave with
        // the splice — there is no await between the two for the event loop to use.)
        this.entries.splice(0, this.entries.length, ...rebuilt);
    }

    /**
     * Resolve a token id to its capabilities, or null when the id is not in the CURRENT
     * set. Used by the stdio MCP reload path — `Object.assign(liveCaps, capsById(id))`
     * refreshes the one caps object every already-registered tool handler closed over.
     *
     * NOT an authentication step and deliberately not constant-time: an id is a public
     * label (it appears in every audit line), not a secret. Never route a caller-supplied
     * value here — `authenticate()` is the only entry point for anything a caller sends.
     *
     * Returns a copy, with the arrays cloned: the caller assigns the result into a
     * long-lived object, and a shared array reference would let a later push on that
     * object silently widen the stored token's grants.
     */
    capsById(id: string): Capabilities | null {
        let found: Capabilities | null = null;
        // Last match wins, consistent with authenticate(). The loader derives a token's
        // keys from its id, so `TOKENS=a,a` can only yield identical entries — there is
        // no divergent-duplicate case to arbitrate.
        for (const entry of this.entries) {
            if (entry.caps.id === id) found = entry.caps;
        }
        return found
            ? { id: found.id, datasources: [...found.datasources], canWrite: found.canWrite, schemas: [...found.schemas] }
            : null;
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
