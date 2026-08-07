import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactErrorMessage } from '../src/query/redact-error.js';

test('redacts pg auth-failure that names the DB user', () => {
    const out = redactErrorMessage(new Error('password authentication failed for user "mds_dev"'));
    assert.doesNotMatch(out, /mds_dev/);
    assert.match(out, /\[redacted\]/);
});

test('redacts connection URIs and key=value connection params', () => {
    assert.doesNotMatch(redactErrorMessage(new Error('connect to postgres://u:p@db.internal:5432/app failed')), /db\.internal|u:p/);
    const kv = redactErrorMessage(new Error('bad config host=10.0.0.5 user=svc password=hunter2 dbname=app'));
    assert.doesNotMatch(kv, /10\.0\.0\.5|svc|hunter2/);
});

test('redacts getaddrinfo/connect host errors (incl. underscore errnos)', () => {
    assert.doesNotMatch(redactErrorMessage(new Error('getaddrinfo ENOTFOUND db.secret.host')), /db\.secret\.host/);
    assert.doesNotMatch(redactErrorMessage(new Error('getaddrinfo EAI_AGAIN db.secret.host')), /db\.secret\.host/);
    assert.doesNotMatch(redactErrorMessage(new Error('connect ECONNREFUSED 10.0.0.5:5432')), /10\.0\.0\.5/);
});

test('redacts pg_hba.conf entry (space-quoted host/user/database)', () => {
    const out = redactErrorMessage(new Error('no pg_hba.conf entry for host "10.0.0.5", user "svc", database "app", SSL off'));
    assert.doesNotMatch(out, /10\.0\.0\.5|"svc"|"app"/);
});

test('redacts "could not translate host name"', () => {
    assert.doesNotMatch(redactErrorMessage(new Error('could not translate host name "db.internal" to address: nodename nor servname provided')), /db\.internal/);
});

test('preserves useful, non-secret SQL errors', () => {
    const msg = 'column "foo" does not exist';
    assert.equal(redactErrorMessage(new Error(msg)), msg);
    const syntax = 'syntax error at or near "SELCT"';
    assert.equal(redactErrorMessage(new Error(syntax)), syntax);
});

test('handles non-Error / empty input', () => {
    assert.equal(redactErrorMessage(undefined), 'request failed');
    assert.equal(redactErrorMessage(''), 'request failed');
    assert.equal(redactErrorMessage('plain string message'), 'plain string message');
});
