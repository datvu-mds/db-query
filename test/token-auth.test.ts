import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenAuth } from '../src/auth/token-auth.js';
import { makeConfig } from './helpers.js';

function auth(): TokenAuth {
    return new TokenAuth(makeConfig().tokens);
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
