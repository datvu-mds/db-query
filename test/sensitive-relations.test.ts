import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sensitiveRelationMatch } from '../src/query/sensitive-relations.js';

test('matches unambiguous secret/credential/token/key stores (whole-token, families)', () => {
    for (const rel of [
        'secrets',
        'secret',
        'client_secrets',
        'app_secret',
        'webhook_secrets',
        'user_secrets',
        'passwords',
        'passwd',
        'password_hash',
        'password_resets',
        'credentials',
        'user_credentials',
        'api_keys',
        'apikey',
        'access_keys',
        'private_keys',
        'signing_key',
        'encryption_keys',
        'ssh_keys',
        'access_tokens',
        'refresh_tokens',
        'auth_tokens',
        'session_tokens',
        'oauth',
        'oauth_access_tokens',
        'personal_access_tokens',
        'recovery_codes',
        'backup_codes',
        'otp',
        'login_otp',
        'totp',
        'mfa_secrets',
        'two_factor_backup',
        'vault',
        'secret_vault',
        'keystore',
        'keyring',
        'hmac_keys',
        // glued compounds (no separator) — caught via the substring list
        'credentialstore',
        'credentialsvault',
        'apikeystore',
        'passwordstore',
    ]) {
        assert.ok(sensitiveRelationMatch(rel), `expected sensitive: ${rel}`);
    }
});

test('is case-insensitive', () => {
    assert.ok(sensitiveRelationMatch('API_KEYS'));
    assert.ok(sensitiveRelationMatch('OAuth_Tokens'));
});

test('does NOT flag generic identity or ordinary business tables (no over-block)', () => {
    for (const rel of [
        'users',
        'user',
        'accounts',
        'account',
        'sessions',
        'session',
        'tokens', // bare "tokens" intentionally not sensitive
        'identities',
        'logins',
        'orders',
        'customers',
        'products',
        'invoices',
        'crypto_prices', // must not match 'otp' as a substring
        'user_profiles',
        'account_settings',
        'order_items',
        'dotproduct', // 'otp' inside a word must not match (boundary guard)
        'secretary', // 'secret' is boundary-only, NOT substring — must not false-positive
        'secretariat',
    ]) {
        assert.equal(sensitiveRelationMatch(rel), null, `expected NOT sensitive: ${rel}`);
    }
});
