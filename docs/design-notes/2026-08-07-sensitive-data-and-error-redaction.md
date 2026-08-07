# Sensitive-relation denylist (secure-by-default) + connection-error redaction

Date: 2026-08-07

## Problem

The MCP gateway is a database **query gateway**: `run_query` lets the LLM `SELECT`
table data, bounded by read-only txn + schema caps + catalog block + a per-datasource
`DENIED_TABLES` list. Two structural gaps let sensitive data reach the LLM:

1. **`DENIED_TABLES` ships EMPTY** (`config.schema.ts`, "generic on purpose"). With a
   `*`-schema token and no operator config, the LLM can read *any* table in *any* tenant
   schema — including credential / secret / token / PII stores. The one guard that would
   stop that is off until someone remembers to configure it.
2. **Error text is returned verbatim** to the caller (`tools.ts` `fail(e.message)`,
   `query.route.ts`). A *connection* failure surfaces the raw driver error, which can
   carry connection metadata (`password authentication failed for user "mds_dev"`,
   `getaddrinfo ENOTFOUND <host>`) — i.e. "database connection" info to the LLM. (The
   password itself is never in a pg error, but host/user/db are.)

Note what is NOT a gap: no tool result, the server `instructions`, or the datasources
route ever returns host/user/password. The `.env` file itself is guarded at the harness
layer (privacy-block hook + sandbox), outside this repo.

## Structure

Two independent, composable additions — both live where the existing guards live, so
there is one place per concern and the transports (HTTP + MCP) inherit them identically.

**A. Built-in sensitive-relation denylist** — new `src/query/sensitive-relations.ts`, the
single source of truth for name-pattern fragments (mirrors `banned-functions.ts`). The
relation-guard checks each referenced relation against it, in addition to the operator's
`DENIED_TABLES`:

- **Merged, not replacing.** Union with `DENIED_TABLES`; operator list still works.
- **Name-pattern, not exact.** Matches credential/secret/token families as a *token*
  within the name (`user_secrets`, `oauth_tokens`, `api_keys_v2`) via a boundary regex, so
  it survives separators and pluralization. A small curated set of zero-false-friend roots
  (`credential`, `apikey`, `password`, `passwd`) is *also* matched as a bare substring so
  glued compounds (`credentialstore`, `apikeystore`) are caught. Roots with false-friends
  (`secret`→`secretary`) stay boundary-only; glued forms like `secretstore` are therefore
  NOT caught by name — operators add those to `DENIED_TABLES` (the DB role is the backstop).
- **Secure-by-default, disableable.** Per-datasource `sensitiveRelationDenylist` boolean,
  default `true`; set `DS_<NAME>_SENSITIVE_RELATION_DENYLIST=false` (or the `DATABASE_`
  form) to turn the built-in off while keeping the explicit `DENIED_TABLES`.
- **Skipped exactly where the config denylist is** — by `allowUnsafeStatements` and for
  the gateway's own internal catalog queries (introspection/boot). Blocks are audited via
  the existing `auditError` path (so "logged" is free).

Scope decision: the default list targets **unambiguous secret material** (secret,
password, credential, api_key, access/refresh/auth/session token, oauth, private/signing/
encryption key, recovery/backup code, otp/totp/mfa, vault/keystore/hmac). It deliberately
does NOT include generic identity tables (`users`, `accounts`, `sessions`, bare `tokens`,
`identities`) — those are far too common as legitimate business tables, and blocking them
by default would break ordinary debugging. Operators who want them denied add them to
`DENIED_TABLES`.

**B. Connection-error redaction** — new `src/query/redact-error.ts`:

- Fix at source: `query-service.ts` stops embedding the raw driver detail in the
  caller-facing `ServiceUnavailableError` for connect failures. The detail still goes to
  the **audit log** (server-side), only the caller sees a generic "datasource unavailable".
- Belt-and-braces at the boundary: `redactErrorMessage()` scrubs connection-URI /
  `password=` / `user=…@host` / auth-failure patterns from any message before it is
  returned by the MCP tool and the HTTP route — so a future error path can't regress the
  leak. Our own typed gateway errors (Bad/Forbidden/ServiceUnavailable messages we author)
  pass through unchanged; useful SQL errors (syntax, undefined column) are kept.

## Tradeoffs

- **Over-blocking** is the accepted cost of secure-by-default (chosen explicitly). A table
  like `client_secrets` used legitimately is blocked until the operator disables the
  built-in for that datasource or the pattern is tuned. Mitigated by: conservative default
  scope, per-datasource off switch, audit logging of every block, and a clear error message.
- **The durable read-only/least-privilege guarantee is still the non-superuser DB role**
  (`agent_ro_pg`, tracked separately in `docs/runbooks/agent-ro-pg-role.md` and the risk
  doc). This change reduces *data* exposure; it is defense-in-depth, not a substitute for
  the DB role.
- Rejected: a strict allowlist (invert the policy). Most secure but breaks the gateway's
  general inspection/debugging purpose — not what a read gateway is for.
