/**
 * sensitive-relations — the built-in, secure-by-default denylist of relation NAME
 * patterns that typically hold credentials / identity secrets / tokens / keys.
 *
 * Why it exists: `run_query` is a data gateway, and the per-datasource `DENIED_TABLES`
 * config ships EMPTY (generic on purpose). Without this, a `*`-schema token can read any
 * credential/secret table that happens to live in a tenant schema. This list is the
 * safety net that protects obvious secret stores even when the operator configured no
 * denylist. It is MERGED with (never replaces) `DENIED_TABLES`, and enforced by
 * relation-guard.ts on every referenced relation.
 *
 * Scope decision (see docs/design-notes/2026-08-07-sensitive-data-and-error-redaction.md):
 * we match UNAMBIGUOUS secret material only. We deliberately do NOT list generic identity
 * tables (`users`, `accounts`, `sessions`, bare `tokens`, `identities`) — those are far
 * too common as legitimate business tables; blocking them by default would break ordinary
 * debugging. Operators who want them denied add them to `DENIED_TABLES`.
 *
 * Matching is NAME-PATTERN, not exact. Two lists:
 *   - SENSITIVE_RELATION_SOURCES — matched as a TOKEN bounded by start/end or a
 *     non-alphanumeric separator, so separated/pluralized forms are caught (`user_secrets`,
 *     `oauth_tokens`, `v2_api_keys`). `_?` inside a source absorbs the optional underscore
 *     (`api_key` and `apikey` both match). Boundary-matched because roots like `secret`
 *     have false-friends (`secretary`) that must NOT be blocked.
 *   - SENSITIVE_RELATION_SUBSTRING_SOURCES — a small set of roots with NO common
 *     false-friends, matched as a bare SUBSTRING (even glued, no separator), so
 *     `credentialstore`, `apikeystore`, `passwordstore`, `credentialsvault` are caught too.
 */

/** Whole-token name fragments (regex source, case-insensitive), grouped by danger class. */
export const SENSITIVE_RELATION_SOURCES = [
    // Secrets
    'secrets?',
    'client_?secrets?',
    'app_?secrets?',
    'webhook_?secrets?',
    // Passwords
    'passwords?',
    'passwd',
    'password_?hash(es)?',
    'password_?resets?',
    // Credentials
    'credentials?',
    // Keys (API / access / crypto)
    'api_?keys?',
    'access_?keys?',
    'secret_?keys?',
    'private_?keys?',
    'signing_?keys?',
    'encryption_?keys?',
    'ssh_?keys?',
    // Auth tokens (paired with an auth word — bare "tokens" is intentionally NOT listed)
    'access_?tokens?',
    'refresh_?tokens?',
    'auth_?tokens?',
    'session_?tokens?',
    'bearer_?tokens?',
    'id_?tokens?',
    'personal_?access_?tokens?',
    'oauth\\w*',
    // Second-factor / recovery
    'recovery_?codes?',
    'backup_?codes?',
    'otp',
    'totp',
    'mfa_?secrets?',
    'two_?factor\\w*',
    // Secret stores
    'vaults?',
    'keystores?',
    'keyrings?',
    'hmac\\w*',
] as const;

/** Roots with no common English false-friends → safe to match as a bare substring anywhere,
 *  catching glued compounds a boundary match misses. `secret` is deliberately NOT here (it
 *  would block `secretary`); operators wanting `secretstore`-style names denied add them to
 *  DENIED_TABLES. */
export const SENSITIVE_RELATION_SUBSTRING_SOURCES = ['credential', 'apikey', 'password', 'passwd'] as const;

/**
 * Return the matched relation name when `relation` looks like a sensitive store, else null.
 * A source matches only as a whole token: bounded by string start/end or a character that
 * is not `[a-z0-9]`. That boundary is what stops `otp` from matching inside `crypto` while
 * still catching `login_otp`, and stops `secrets` from matching a substring of an unrelated
 * word while still catching `user_secrets`.
 */
export function sensitiveRelationMatch(relation: string): string | null {
    const r = relation.toLowerCase();
    for (const src of SENSITIVE_RELATION_SUBSTRING_SOURCES) {
        if (r.includes(src)) return relation;
    }
    for (const src of SENSITIVE_RELATION_SOURCES) {
        if (new RegExp(`(^|[^a-z0-9])(${src})([^a-z0-9]|$)`, 'i').test(r)) return relation;
    }
    return null;
}
