/**
 * Fail-safe network binding. This gateway holds live DB credentials and, over
 * HTTP, the only barrier in front of them is a plaintext bearer secret — so
 * listening anywhere but loopback is never something that should happen by accident.
 *
 * Both listen() sites go through here: `server.ts` (Fastify, uses `config.host`)
 * and `mcp/mcp-http.ts` (uses `MCP_HTTP_HOST`). Each has its own default and its
 * own env var, which is exactly why the check is shared rather than inlined —
 * one rule, no site left unguarded when the next transport is added.
 *
 * ALLOWLIST, NOT DENYLIST. Enumerating "bad" hosts loses: `''`, `0`, `0.0`, `::0`,
 * `0.0.0.0`, `::`, `0x0` and more all make Node bind every interface (verified —
 * an empty or bare-integer host is resolved rather than rejected, and
 * `net.isIP('0')` is 0, so even IP parsing does not catch it). So we invert the
 * question: a host must be recognisably loopback, or the operator must say
 * ALLOW_PUBLIC_BIND=true. An unknown host form fails closed.
 *
 * Consequence worth knowing: binding a specific non-loopback address (a private
 * 10.x interface, say) also needs the flag. That is a deliberate act either way,
 * and one unbypassable rule beats two subtle ones.
 */

/**
 * Hosts that cannot reach beyond this machine. `localhost` is included because it
 * resolves to a loopback address on every supported platform; `127.0.0.0/8` is
 * matched by prefix since the whole block is loopback.
 */
function isLoopbackHost(host: string): boolean {
    const h = host.trim().toLowerCase();
    if (h === 'localhost') return true;
    // IPv6 loopback, bare or bracketed, including the fully-expanded form.
    if (h === '::1' || h === '[::1]' || h === '0:0:0:0:0:0:0:1') return true;
    // IPv4 loopback block: 127.0.0.0/8. Require 4 octets so `127` alone (which Node
    // would resolve to 127.0.0.1) is not matched by a looser rule elsewhere.
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** True when `host` is safe to bind without an explicit opt-in. */
export function isSafeBindHost(host: string): boolean {
    return isLoopbackHost(host);
}

/**
 * Throws unless `host` is loopback or ALLOW_PUBLIC_BIND=true. `context` names the
 * transport in the error so the operator knows which env var to set.
 */
export function assertBindAllowed(host: string, context: string): void {
    if (isSafeBindHost(host)) return;
    if (process.env.ALLOW_PUBLIC_BIND === 'true') return;
    const shown = host.trim() === '' ? '<empty>' : host;
    throw new Error(
        `Refusing to start ${context} on ${shown}: only loopback is bound without an explicit opt-in, ` +
            `because this gateway holds database credentials and is guarded over HTTP by nothing but a ` +
            `bearer secret. Note an empty or wildcard host (''/0/0.0.0.0/::) binds EVERY interface. ` +
            `Set HOST=127.0.0.1 for local use, or ALLOW_PUBLIC_BIND=true — with TLS termination and a ` +
            `rotated secret — to bind a non-loopback interface on purpose.`,
    );
}
