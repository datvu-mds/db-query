/**
 * redact-error — scrub connection/credential metadata out of any error message
 * before it is returned to a caller (the MCP tool result or the HTTP error body).
 *
 * The gateway holds DB credentials; a raw driver error on a *connection* failure can
 * carry host/user/db (e.g. `password authentication failed for user "mds_dev"`,
 * `getaddrinfo ENOTFOUND db.internal`). QueryService already avoids embedding that detail
 * in the caller-facing error (it logs the detail server-side and returns a generic
 * message), so this is the belt-and-braces boundary scrub: it guarantees no future error
 * path can regress the leak. SQL errors (syntax, undefined column) are about the caller's
 * own query and are preserved — only secret-shaped fragments are masked.
 */

/** Patterns whose whole match is replaced with a redaction marker. */
const REDACTIONS: RegExp[] = [
    // Full connection URIs: postgres://user:pass@host:port/db
    /\b(postgres(?:ql)?|pg):\/\/[^\s'"]+/gi,
    // key=value connection params that carry secrets/locators
    /\b(password|passwd|pwd|user|username|host|hostname|dbname|database|port)\s*=\s*("[^"]*"|'[^']*'|[^\s;'"]+)/gi,
    // locator/identity as a quoted token, e.g. pg's `no pg_hba.conf entry for host "10.0.0.5",
    // user "svc", database "app"` and `... for user "mds_dev"`.
    /\b(host|hostname|user|username|database|dbname|role)\s+("[^"]*"|'[^']*')/gi,
    // pg auth-failure phrasing that names the DB user (bare, unquoted form too)
    /password authentication failed for user\s+("[^"]*"|'[^']*'|\S+)/gi,
    // DNS resolution failure that names the host
    /could not translate host name\s+("[^"]*"|'[^']*'|\S+)/gi,
    // getaddrinfo / connect errors that name the host or address, e.g.
    // `getaddrinfo ENOTFOUND db.host`, `getaddrinfo EAI_AGAIN db.host`,
    // `connect ECONNREFUSED 10.0.0.5:5432`. The errno may contain an underscore
    // (`EAI_AGAIN`), so match `E[A-Z_]+`; then consume the host/address token too.
    /\b(getaddrinfo|connect)\s+(E[A-Z_]+\s+)?\S+/gi,
];

/** Return a message safe to hand back to a caller. Empty/undefined → generic text. */
export function redactErrorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    if (!raw) return 'request failed';
    let out = raw;
    for (const re of REDACTIONS) out = out.replace(re, '[redacted]');
    return out;
}
