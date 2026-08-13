import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenAuth } from '../src/auth/token-auth.js';
import type { TokenConfig } from '../src/config/config.schema.js';
import { makeConfig } from './helpers.js';

function auth(): TokenAuth {
    return new TokenAuth(makeConfig().tokens);
}

/** Minimal TokenConfig for the reload cases — same shape the loader produces. */
function tok(id: string, secret: string, over: Partial<TokenConfig> = {}): TokenConfig {
    return { id, secret, datasources: ['main'], mode: 'read', schemas: ['*'], ...over };
}

test('valid bearer resolves to capabilities', () => {
    const caps = auth().authenticate('Bearer ro-secret');
    assert.ok(caps);
    assert.equal(caps?.id, 'agent_ro');
    assert.equal(caps?.canWrite, false);
});

test('write token maps to canWrite', () => {
    const caps = auth().authenticate('Bearer rw-secret');
    assert.equal(caps?.canWrite, true);
});

test('unknown secret → null (401)', () => {
    assert.equal(auth().authenticate('Bearer nope'), null);
});

test('missing / malformed header → null', () => {
    assert.equal(auth().authenticate(undefined), null);
    assert.equal(auth().authenticate('ro-secret'), null); // no Bearer prefix
    assert.equal(auth().authenticate('Bearer '), null);
});

test('datasource not in caps → 403', () => {
    const a = auth();
    const caps = a.authenticate('Bearer rw-secret')!; // svc_rw: only main
    const r = a.authorize(caps, { datasource: 'other', schema: 'public', writeRequested: false });
    assert.deepEqual(r, { ok: false, status: 403, reason: 'datasource "other" not permitted' });
});

test('schema not allowed → 403', () => {
    const a = auth();
    const caps = a.authenticate('Bearer rw-secret')!; // svc_rw schemas: ['public']
    const r = a.authorize(caps, { datasource: 'main', schema: 'tenant_x', writeRequested: false });
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 403);
});

test('write requested by read-only token → 403 write-not-permitted', () => {
    const a = auth();
    const caps = a.authenticate('Bearer ro-secret')!;
    const r = a.authorize(caps, { datasource: 'main', schema: 'anything', writeRequested: true });
    assert.deepEqual(r, { ok: false, status: 403, reason: 'write-not-permitted' });
});

test('read-only token with wildcard schemas allows any schema for read', () => {
    const a = auth();
    const caps = a.authenticate('Bearer ro-secret')!; // schemas ['*']
    const r = a.authorize(caps, { datasource: 'main', schema: 'any-uuid', writeRequested: false });
    assert.deepEqual(r, { ok: true });
});

test('write token writing to its allowed schema → ok', () => {
    const a = auth();
    const caps = a.authenticate('Bearer rw-secret')!;
    const r = a.authorize(caps, { datasource: 'main', schema: 'public', writeRequested: true });
    assert.deepEqual(r, { ok: true });
});

// ── applyTokens / capsById — the config-reload surface ────────────────────────

test('SECURITY: applyTokens grants a new token and revokes a removed one', () => {
    // `a` stands in for the instance routes/MCP tools captured at registration: they
    // never re-read Services, so the reload has to be visible through THIS reference.
    const a = auth();
    assert.ok(a.authenticate('Bearer ro-secret'));

    a.applyTokens([tok('agent_new', 'new-secret', { datasources: ['warehouse'] })]);

    assert.equal(a.authenticate('Bearer ro-secret'), null, 'removed token must stop authenticating');
    assert.equal(a.authenticate('Bearer rw-secret'), null, 'removed token must stop authenticating');
    const caps = a.authenticate('Bearer new-secret');
    assert.equal(caps?.id, 'agent_new');
    assert.deepEqual(caps?.datasources, ['warehouse']);
});

test('SECURITY: constant-time scan survives applyTokens (every entry scanned, no early return)', () => {
    // Proxy for the property, not the property itself: authenticate() has no early
    // return, so when two entries share a secret the LAST one wins. An `if (!matched)`
    // short-circuit — which would reintroduce a timeable match position — returns the
    // FIRST and fails here. A timing assertion would be flaky; this one is exact.
    const dup = [
        tok('first_dup', 'same-secret'),
        tok('other', 'other-secret'),
        tok('last_dup', 'same-secret', { mode: 'write' }),
    ];

    assert.equal(new TokenAuth(dup).authenticate('Bearer same-secret')?.id, 'last_dup', 'ctor path');

    const applied = auth();
    applied.applyTokens(dup);
    assert.equal(applied.authenticate('Bearer same-secret')?.id, 'last_dup', 'post-apply path');

    // Fixed-length SHA-256 digests on both sides: timingSafeEqual throws on a length
    // mismatch, so a wildly-long secret comparing cleanly to null proves the rebuilt
    // entries are still digests and no length-dependent path was introduced.
    assert.equal(applied.authenticate(`Bearer ${'x'.repeat(10_000)}`), null);
});

test('capsById resolves a known id and returns null for an unknown one', () => {
    const a = auth();
    const caps = a.capsById('svc_rw');
    assert.equal(caps?.id, 'svc_rw');
    assert.equal(caps?.canWrite, true);
    assert.deepEqual(caps?.datasources, ['main']);
    assert.deepEqual(caps?.schemas, ['public']);
    assert.equal(a.capsById('nope'), null);

    // Resolves against the CURRENT set — this is what the stdio MCP path re-reads
    // after a reload to refresh the caps object its tool handlers closed over.
    a.applyTokens([tok('svc_rw', 'rw-secret-2', { datasources: ['main', 'warehouse'], mode: 'write' })]);
    assert.deepEqual(a.capsById('svc_rw')?.datasources, ['main', 'warehouse']);
    assert.equal(a.capsById('agent_ro'), null, 'an id dropped by the reload must not resolve');
});

test('SECURITY: capsById returns a copy — mutating it cannot widen the stored grants', () => {
    const a = auth();
    // The stdio path Object.assign()s this result into a caps object held for the
    // process lifetime, so a shared array reference would let a later push on the live
    // object silently widen the token's stored grants.
    const caps = a.capsById('svc_rw')!;
    caps.datasources.push('*');
    caps.schemas.push('*');

    assert.deepEqual(a.capsById('svc_rw')?.datasources, ['main']);
    assert.deepEqual(a.capsById('svc_rw')?.schemas, ['public']);
    assert.deepEqual(a.authenticate('Bearer rw-secret')?.datasources, ['main']);
});

test('SECURITY: applyTokens([]) denies everyone rather than keeping stale grants', () => {
    // An empty set must mean "nobody authenticates", never "keep the previous grants" —
    // a `if (!next.length) return;` guard here would fail OPEN on an emptied config.
    const a = auth();
    a.applyTokens([]);
    assert.equal(a.authenticate('Bearer ro-secret'), null);
    assert.equal(a.authenticate('Bearer rw-secret'), null);
    assert.equal(a.capsById('agent_ro'), null);
});

test('SECURITY: no plaintext secret is retained for comparison', () => {
    // TS `private` is compile-time only, so this really does catch a retained
    // TokenConfig[] (the tempting shortcut for backing capsById).
    const a = auth();
    a.applyTokens([tok('agent_ro', 'ro-secret')]);
    assert.ok(!JSON.stringify(a).includes('ro-secret'), 'TokenAuth must keep digests only, never the secret');
});
