# pg-connection-pool — Query Gateway

A lightweight **query-execution gateway** (Fastify + `pg` + `zod` + `pino`). It owns
one pooled `pg.Pool` per logical datasource and runs queries on a caller's behalf under
guardrails. Callers know only a **logical datasource name** + SQL — never a connection,
credentials, host, or engine type. A parallel **MCP adapter** exposes the same
capability to agents.

> Design note (authoritative): `../docs/design-notes/pg-connection-pool-query-gateway.md`

## Why

External consumers (application services and debugging agents) need *real
data* from Postgres to reproduce scenarios, without managing credentials or connection
lifecycle. A live socket can't cross an HTTP/MCP boundary, so the server **owns** the
pool and exposes a guarded QUERY capability instead of a connection.

## Core invariants

- **Server owns the pool**, exposes a QUERY capability — never a raw connection.
- **One `pg.Pool` per datasource**, shared across tenants. Tenant isolation is per-query:
  every query runs inside a transaction with `SET LOCAL search_path TO "<schema>", pg_temp`,
  which auto-resets on COMMIT/ROLLBACK so a pooled connection can't leak one tenant's
  `search_path` to the next borrower. **This is a P0 correctness invariant.**
- **Connections are returned pristine**: `SET LOCAL` only auto-resets the settings *we*
  issue — a caller's own plain `SET` survives COMMIT on that pooled connection. Every
  query therefore ends with `DISCARD ALL`, which also drops temp tables and prepared
  statements. Without it, `SET statement_timeout = 0` in one request silently disabled
  the timeout guardrail for every later borrower of that connection.
- **One statement per request, enforced by the wire protocol.** All SQL runs through the
  extended protocol (`queryMode:'extended'`), under which *the server* rejects
  multi-statement text. This is structural; the text scanner is only a fast 400.
- **Read-only by default**, enforced at the engine (`BEGIN TRANSACTION READ ONLY`) with a
  DB-role backstop; an app-layer **statement guard** (leading-keyword allowlist + banned
  side-effecting-function scan) adds defense-in-depth for what a read-only txn does *not*
  stop (`COPY`, `pg_read_file`, …), and a **relation guard** (real-parser tree walk) bounds
  *what/where* a query may read (catalog block + schema caps + denied tables) — belt to the
  braces, never the sole barrier. Writes are opt-in (see below).
- **Layered timeouts**: `connectionTimeoutMillis` (acquire), `statement_timeout` (query),
  `idle_in_transaction_session_timeout` (stalled txn).
- `acquire → use → release-in-finally`; a mandatory `pool.on('error')` handler on every
  pool; graceful shutdown drains pools; fail-fast boot (one `SELECT 1` per datasource).

## Configuration (`.env`)

See `.env.example`. Logical datasource names decouple callers from real endpoints:

```
DATASOURCES=main
DS_MAIN_HOST=localhost
DS_MAIN_USER=postgres
DS_MAIN_PASSWORD=postgres
DS_MAIN_DATABASE=appdb
DS_MAIN_DEFAULT_SCHEMA=public
DS_MAIN_STATEMENT_TIMEOUT_MS=10000

TOKENS=agent_ro,svc_rw
TOKEN_AGENT_RO_SECRET=...   TOKEN_AGENT_RO_DATASOURCES=main  TOKEN_AGENT_RO_MODE=read   TOKEN_AGENT_RO_SCHEMAS=*
TOKEN_SVC_RW_SECRET=...     TOKEN_SVC_RW_DATASOURCES=main    TOKEN_SVC_RW_MODE=write    TOKEN_SVC_RW_SCHEMAS=public
```

- **Fallback:** if NO `DS_*` datasource is configured, a single `main` is seeded from
  the canonical `DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME/SSL`.
- **Hard caps:** `MAX_ROWS_CEILING` (default `10000`) is the absolute row cap; a request's
  `maxRows` is clamped to it. A request's `timeoutMs` is clamped to the datasource's
  `STATEMENT_TIMEOUT_MS`.
- **Binding:** `HOST` defaults to `127.0.0.1`. Only loopback binds without
  `ALLOW_PUBLIC_BIND=true` — see [Network binding](#network-binding).
- **Denied tables:** `DS_<NAME>_DENIED_TABLES` is a comma list of relations the
  [relation guard](#relation-guard-schema-boundary--metadata-block--denylist) rejects
  (400) before DB contact. Entries are `table` (matches in ANY schema) or `schema.table`
  (exact); case-insensitive. **Code default is EMPTY** — the gateway is generic, so a
  deployment must declare its own list in `.env` (see `.env.example`); boot logs the count.
- **DB role:** point each datasource at a **read-only Postgres role**; that, not the
  token mode, is the real write barrier. See [The read-only guarantee](#the-read-only-guarantee-lives-in-the-database).

## HTTP API

| Method + path            | Auth | Purpose |
|--------------------------|------|---------|
| `GET  /health`           | no   | `{ status, datasources:[{name, ok, poolSize}] }` (503 if degraded) |
| `GET  /datasources`      | yes  | datasources this token may use |
| `POST /query`            | yes  | run one statement |
| `POST /introspect/schemas`  | yes | schemas visible to the token |
| `POST /introspect/tables`   | yes | `{ datasource, schema }` → tables + views |
| `POST /introspect/describe` | yes | `{ datasource, schema, table }` → columns |

Auth is `Authorization: Bearer <secret>`. `POST /query` body:

```jsonc
{ "datasource": "main", "schema": "<account-uuid>", "sql": "SELECT ...",
  "params": [1, "x"], "readOnly": true, "maxRows": 1000, "timeoutMs": 10000 }
```

Response: `{ columns:[{name,dataType}], rows:[...], rowCount, truncated, elapsedMs, rowsAffected? }`.

### Writes (opt-in)

A write requires **both** a write-mode token **and** an explicit `"readOnly": false`. A
read-only token with `readOnly:false` is rejected (403) before any DB contact. Write
queries add `write:true`, `command`, and `rowsAffected` to the audit line.

## MCP adapter

Exposes `run_query`, `list_schemas`, `list_tables`, `describe_table` over MCP — thin
wrappers over the SAME services, so all guardrails/auth/audit apply identically.

The server also advertises usage **`instructions`** (built from the live identity — the
datasource list and read/write posture are accurate, not aspirational). MCP clients like
Claude Code surface these in the agent's system prompt, so **any project that registers
the server gets the usage guidance automatically** ("prefer over ad-hoc psql", the
datasource name, the params-not-literals rule) — no per-project CLAUDE.md rule to write
or keep in sync. That said, the guidance appears only in clients that surface MCP server
instructions; if you want the preference committed in-repo for teammates or non-surfacing
clients, add a short project rule too.

- Identity is process-level: set `MCP_TOKEN=<a configured secret>`; the process runs with
  that token's capabilities.
- `npm run start:mcp` — stdio (default; for a local agent client).
- `npm run start:mcp:http` — streamable HTTP (`MCP_TRANSPORT=http`), binds loopback by
  default (`MCP_HTTP_HOST`/`MCP_HTTP_PORT`). Never expose publicly — trusted infra utility.
- `npm run inspect` — MCP inspector against the built server.

### Quick install into any project

`install-mcp.sh` registers this gateway as a Claude Code MCP server pointing at
**this** shared install (its single `.env` = one home for DB creds + `MCP_TOKEN`). It
never copies the server, so credentials never fork. It builds the gateway if needed,
refuses to register against a missing/placeholder `.env`, and is idempotent.

```
./install-mcp.sh              # user scope → available in EVERY project, nothing else to do
./install-mcp.sh --project    # write ./.mcp.json here (committable — teammates inherit it)
./install-mcp.sh --project DIR # write DIR/.mcp.json
./install-mcp.sh --local      # this project only, private
./install-mcp.sh --link       # symlink onto PATH as `pgcp-mcp-install` for future one-liners
./install-mcp.sh --print      # just print the JSON block
```

Then run `/mcp` in the Claude Code session to connect. Because it emits an **absolute**
path, the entry works from any project regardless of where it lives.

## Scripts

```
npm run dev         # tsx watch (HTTP server)
npm run build       # tsc → dist/
npm start           # node dist/server.js  (HTTP)
npm run start:mcp   # MCP over stdio
npm run typecheck
npm test            # node --test via tsx
```

## Local Postgres (`docker-compose.yml`)

A PostgreSQL 18 container for local development:

```
docker compose up -d          # start
docker compose logs -f pg     # watch
docker compose down           # stop (data survives in the pgcp-pgdata volume)
docker compose down -v        # stop AND delete the data
```

Credentials are **not duplicated**. Compose auto-loads `.env` from this directory, so
`DS_MAIN_USER` / `_PASSWORD` / `_DATABASE` become the container's `POSTGRES_*` and the
compose file itself holds no secrets. A missing value is a startup error, not a
password-less superuser. Only `POSTGRES_*` are passed in — the bearer secrets and
`MCP_TOKEN` are deliberately withheld from the DB container.

The host port mirrors `DS_MAIN_PORT`, so **pointing the gateway at this container is a
one-line change**: set `DS_MAIN_HOST=localhost`.

Two deliberate choices worth knowing:

- **Published on `127.0.0.1` only.** A bare `"5432:5432"` publishes on every interface —
  the same footgun [Network binding](#network-binding) refuses for the gateway itself.
- **`PGDATA` is set explicitly** (to a subdirectory of the mount) rather than inherited
  from the image, whose default has moved between major versions.

### It is an empty database

A fresh container has none of the dev data, so two things do not work out of the box:

- `DS_MAIN_DEFAULT_SCHEMA` is a tenant UUID schema that will not exist. The boot ping
  (`SELECT 1`) passes, but any query resolving that `search_path` fails until you create
  the schema or repoint the var (e.g. `public`).
- The read-only role `agent_ro_pg` does not exist. Creating it is a **user action** (see
  [The read-only guarantee](#the-read-only-guarantee-lives-in-the-database)) — run that SQL
  against the container as the superuser above, then set `DS_MAIN_USER=agent_ro_pg`.
  Until then the boot log will correctly report `read-only posture WEAK`, because the
  superuser this container creates can write everything.

## Testing

- **Unit + E2E route tests** run with no database (a stub `QueryDriver` drives the full
  HTTP/MCP path). `npm test`.
- **Integration tests** (`test/integration/*`) hit a **real** Postgres and are SKIPPED
  unless configured — they prove the P0 tenant isolation, engine read-only enforcement,
  `statement_timeout`, write commit/rollback, and the `SECURITY:`-prefixed regressions
  (server-side multi-statement rejection, read-only-escape, session scrubbing) that a
  stub cannot. Run with:

  ```
  PGCP_TEST_HOST=localhost PGCP_TEST_USER=postgres PGCP_TEST_PASSWORD=postgres \
  PGCP_TEST_DATABASE=postgres npm test
  ```

  (falls back to `DATABASE_*` if `PGCP_TEST_*` are absent). They create/drop throwaway
  `pgcp_test_a` / `pgcp_test_b` schemas.

## Security notes

- Bearer secrets are compared in constant time and never logged (audit logs the token
  *id*, not the secret).
- The schema is applied as a **quoted identifier** (validated, double-quote-escaped); all
  values must be passed via `params` (`$1…`). The audit line records SQL text and error
  text (each capped at 2,000 chars with a `…[+N chars]` marker; a truncated statement also
  records `sqlLength` so it stays attributable) while `params` are **never** logged — so
  **never inline secret values as SQL literals**, use `params`.
- Not an ORM/migration runner (never generates or runs migrations), not a general SQL
  console — it's an infra utility for trusted services/agents.
- **MCP over HTTP** requires the caller to present the process's own token as a bearer and
  enables DNS-rebinding protection (Host allow-list); it still binds loopback by default.
- **`/health` is unauthenticated** but its DB pings are cached (`HEALTH_CACHE_TTL_MS`,
  default 5000ms) and de-duplicated, so probe floods can't exhaust the pool.
- Query error messages are returned to the caller verbatim (a debugging affordance);
  combined with the boundary below, treat error text as revealing structure.

### The read-only guarantee lives in the database

A token's `MODE=read` and the `BEGIN TRANSACTION READ ONLY` wrapper are **app-layer**
controls. They are correct, but they are app logic: one gateway bug, or one
`MODE=read`→`write` edit, removes them. The guarantee that survives that is a Postgres
login role with **no write grants**:

```sql
-- USER ACTION (privilege changes are never run by an agent). Run as superuser/owner.
CREATE ROLE agent_ro_pg WITH LOGIN PASSWORD '<strong-password>';
-- pg_read_all_data (PG14+): SELECT on all current AND FUTURE relations + schema USAGE.
-- Exactly right for schema-per-tenant, where new schemas appear at runtime.
GRANT pg_read_all_data TO agent_ro_pg;
-- Second lock: a plain BEGIN (the write path) is read-only too, so a mode misconfig
-- still cannot write. Advisory only — it is USERSET, so a caller can turn it off.
ALTER ROLE agent_ro_pg SET default_transaction_read_only = on;

-- PG14 only: PUBLIC still holds TEMP on the database, so any role can CREATE TEMP
-- TABLE and write to it. Session-local and cleared by DISCARD ALL, so it cannot touch
-- tenant data — revoke it anyway if you want the "no writes at all" claim to be literal.
-- REVOKE TEMP ON DATABASE <db> FROM PUBLIC;
-- Also PG14: PUBLIC holds CREATE on schema `public` unless revoked (PG15 changed the
-- default). Check with:
--   SELECT has_schema_privilege('public','public','CREATE');
-- REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

Then set `DS_<NAME>_USER=agent_ro_pg` + its password. After this the role can write **no
existing relation** regardless of token mode, transaction mode, a smuggled statement, or a
gateway bug — it holds no privilege to do so.

Do **not** substitute `GRANT pg_write_all_data` for explicit grants on a write datasource:
its privileges are implicit in the ACL check and leave no per-table grant row, so naive
audit queries report it as harmless. (The boot probe below handles it explicitly.)

**Every boot reports the posture** for each datasource (`read-only posture OK` / `WEAK` /
`UNVERIFIED`). It asks whether the role *can* write — `has_table_privilege` /
`has_any_column_privilege` over every non-catalog relation, plus explicit superuser and
`pg_write_all_data` checks — rather than counting `information_schema.table_privileges`
rows, which are built from `relacl` and therefore blind to column-level grants, predefined
roles and superuser. It **fails closed**: a probe error or an unexpected result shape is
reported `UNVERIFIED`, never `OK`. It is a warning, never a hard failure — a legitimately
write-capable datasource may exist — so the point is that a misconfiguration is *loud*
rather than found in a later audit.

One caveat the probe cannot cover: if `dblink` or `postgres_fdw` is installed, `EXECUTE`
defaults to `PUBLIC` and `dblink('…','INSERT …')` writes over a *separate* connection —
outside the read-only transaction and outside any grant the role holds. Revoke `EXECUTE`
on those functions, or don't install them on a database this gateway reaches.

Runbook for creating the role: [`docs/runbooks/agent-ro-pg-role.md`](docs/runbooks/agent-ro-pg-role.md).

### Statement guard (defense-in-depth)

A Postgres `READ ONLY` transaction blocks DB *data/catalog* writes but **not** `COPY … TO
PROGRAM/'file'`, `pg_read_file`/`pg_ls_dir`, backend signals (`pg_terminate_backend`), or
WAL messages (`pg_logical_emit_message`) — all catastrophic under a superuser role (see
[the risk report](docs/risks/2026-07-29-mcp-run_query-write-and-rce-bypass.md)). Every call
therefore passes an app-layer guard at the single `QueryService.run()` choke point (so
HTTP `/query`, MCP `run_query`, and introspection are all covered), **before any DB
contact**:

- **Leading-keyword allowlist.** Read mode permits `SELECT`, `WITH`, `EXPLAIN`,
  `VALUES`, `TABLE`; write mode adds `INSERT`, `UPDATE`, `DELETE`, `MERGE`. Anything else
  (`COPY`, `CALL`, `DO`, `SET`, `ALTER`, `CREATE`, …) is rejected — an allowlist needs no
  per-keyword maintenance. **`SHOW` was removed** — it leaks server settings (`SHOW all` →
  `data_directory`, `config_file`, connection strings) and exposes no relation for the
  relation guard to police; read a specific setting with `current_setting('name')` or
  `SELECT version()` instead.
- **Banned-function scan.** Side-effecting/host-access functions (`pg_read_file`,
  `pg_ls_*`, `lo_export`, `dblink*`, `pg_reload_conf`, `pg_terminate_backend`,
  `pg_logical_emit_message`, `pg_stat_reset*`, …) are rejected in **both** modes, even
  inside an allowed statement (`SELECT pg_read_file(…)`).

Both run over the shared `stripToCode` view ([`sql-lexer.ts`](src/query/sql-lexer.ts)) that
blanks comments/strings/dollar-bodies, so the checks can't be comment- or string-bypassed
(`SELECT 'pg_read_file(' AS note` is allowed; `SELECT/**/pg_read_file(…)` is not). The
function scan reads an ident-revealing variant so a **quoted** call `SELECT
"pg_read_file"(…)` — which Postgres resolves to the same function — is caught too. A
rejection is a `400` and is **audited** (blocked attempts, including `;`-smuggle, show up
in the security stream). The multi-statement scan and the read-only transaction are
separate and always-on.

The `U&"\0070g_read_file"` unicode-escape identifier a text scanner cannot decode is now
closed by the **relation guard** below, which runs the same banned-function list against
the real parser's decoded names. Both scans share one list
([`banned-functions.ts`](src/query/banned-functions.ts)) so they cannot drift; this text
scan stays as belt-and-braces for SQL the parser accepts but shapes differently.

This is **defense-in-depth, not the guarantee** — it ships *with* the non-superuser DB
role above, never instead of it (denylists drift; the role holds no privilege to begin
with).

**Escape hatch.** A datasource whose DB role is trusted and which legitimately needs
admin/`COPY`/file statements can opt out with `DS_<NAME>_ALLOW_UNSAFE_STATEMENTS=true`
(default **false**, fail-closed — any non-`true` value keeps the guard on). It relaxes the
statement guard **and** the relation guard below; the multi-statement scan and the
read-only transaction stay enforced. Enabling it removes two security layers, so **every
boot logs a WARN** naming the datasource.

### Relation guard (schema boundary + metadata block + denylist)

The statement guard answers *whether* a statement may run; it says nothing about *what* it
reads. Read-only is a write control, and the DB role is `pg_read_all_data` — SELECT on
every relation, forever — so on its own the gateway would expose `information_schema`, the
`pg_catalog` views (`pg_tables`, `pg_roles`, `pg_settings`, …), and every identity/secrets
table to any read token. Postgres cannot fix this at the grant layer: `pg_catalog` access
cannot be revoked, and grants are additive so tables cannot be carved out of
`pg_read_all_data`. So the boundary is enforced at the app layer, at the same
`QueryService.run()` choke point, **before any DB contact**:

- **Parse, don't pattern-match.** Every statement is parsed with the *real* Postgres parser
  ([`libpg-query`](src/query/relation-guard.ts)); the guard walks the parse tree for the
  relations it references (CTE-aware — a `WITH` name is not a table) and the functions it
  calls. This includes **write/create targets** on the write path — the `INSERT`/`UPDATE`/
  `DELETE`/`MERGE` target and `SELECT … INTO` — so a write-mode token is confined to its
  caps and the denylist just as reads are (a target named like an enclosing CTE is still the
  real table). Decoded identifiers close the `U&"\0070g_read_file"` / `U&"\0075ser"`
  unicode-escape gap a lexer cannot. **Unparseable SQL is rejected (400)** — SQL the gateway
  cannot understand is SQL it cannot police (fail-closed).
- **Five relation rules:** a relation qualified with a **system schema** (`pg_catalog`,
  `pg_toast`, `pg_temp*`, `information_schema`) → **400**; qualified with **another schema
  outside the token's `SCHEMAS` caps** → **403**; an **unqualified `pg_%`** name (which
  resolves to `pg_catalog`, implicitly first on `search_path`) → **400**; the effective
  schema + relation on the datasource's **`DS_<NAME>_DENIED_TABLES`** list → **400**; and a
  relation whose **name matches the built-in sensitive-relation denylist** → **400**.
- **Built-in sensitive-relation denylist (secure-by-default).** Because `DS_<NAME>_DENIED_TABLES`
  ships empty, a name-pattern safety net ([`sensitive-relations.ts`](src/query/sensitive-relations.ts))
  blocks obvious credential/secret/token/key stores (`secrets`, `api_keys`, `oauth_tokens`,
  `private_keys`, `recovery_codes`, `mfa_secrets`, `vault`, …) even when no denylist is
  configured. It is a token-boundary match (`user_secrets`, `oauth_access_tokens` are caught),
  with a small curated set of zero-false-friend roots (`credential`, `apikey`, `password`)
  also matched as a substring so glued compounds (`credentialstore`) are caught, and it
  deliberately excludes generic identity tables (`users`, `accounts`, `sessions`) to avoid
  over-blocking ordinary reads. Default on, fail-closed — only an explicit
  `DS_<NAME>_SENSITIVE_RELATION_DENYLIST=false`/`0`/`no`/`off` turns it off (boot WARNs when
  it does); skipped by `ALLOW_UNSAFE_STATEMENTS`.
- **Metadata path.** `list_schemas` / `list_tables` / `describe_table` are the sanctioned,
  caps-filtered way to see structure. They run fixed, parameterized `information_schema`
  reads on an **internal trusted route** that a caller cannot request — the trust flag is a
  second positional argument to `run()`, never a request field, so no HTTP body or MCP args
  object can set it. (The boot posture probe uses the same internal route.)
- **Escape hatch.** `DS_<NAME>_ALLOW_UNSAFE_STATEMENTS=true` skips the statement guard **and**
  this relation guard; boot WARNs. Every boot also logs the guard state and denied-table
  count per datasource.

Rejections (both 400 and 403) are **audited** — a qualified cross-schema 403 is the
tenant-probe signal worth alerting on.

**Error redaction.** Error text returned to a caller (MCP tool result / HTTP body) is run
through [`redact-error.ts`](src/query/redact-error.ts): connection URIs, `password=`/`user=…`
params, pg auth-failure user names, and `getaddrinfo`/`connect` host/address details are
masked, so a connection failure can never echo connection metadata to the LLM. The full
detail still goes to the server-side audit log. Useful SQL errors (syntax, undefined column)
pass through unchanged.

**Residual risks (accepted).** A **view** in an allowed schema over a denied table still
reads it (views run with owner privileges; no such views are known — the DB-grants runbook
is the durable fix). Scalar metadata functions (`version()`, `current_setting()`,
`current_user`) stay readable — not table data. And this is app-layer enforcement over a
shared `pg_read_all_data` role: it holds only as long as the guard does. The belt exists;
explicit per-token grants ([runbook](docs/runbooks/agent-ro-pg-role.md)) are the braces.

### Network binding

`HOST` defaults to `127.0.0.1`, and **only loopback binds without an explicit opt-in** —
anything else needs `ALLOW_PUBLIC_BIND=true`. This gateway holds live DB credentials and,
over HTTP, the only thing in front of them is a plaintext bearer secret, so binding beyond
this machine must be a deliberate decision made with TLS termination and a rotated secret.

The check is an **allowlist, not a denylist**, because the set of hosts that bind every
interface cannot be enumerated: `0.0.0.0`, `::`, `0`, `0.0`, `::0`, `0x0` and the *empty
string* all do it (an empty or bare-integer host is resolved rather than rejected, and
`net.isIP('0')` is `0`, so IP parsing does not catch it either). Requiring loopback is the
one rule that cannot be out-spelled. Note this means binding a specific private address
also needs the flag — deliberate either way.

The guard covers both `listen()` sites: the Fastify gateway (`HOST`) and the MCP
streamable-HTTP transport (`MCP_HTTP_HOST`), whose env vars bypass zod and so are
normalised for the empty-string case at the call site.

### Rotating the bearer secret

Secrets are plaintext in `.env` and compared as constant-time SHA-256 digests — never
logged. Rotation is therefore the only exposure control:

1. Generate: `openssl rand -base64 24`
2. Update **both** `TOKEN_<ID>_SECRET` and `MCP_TOKEN` in `.env` — the MCP process
   authenticates as one of the configured tokens, so a mismatch fails boot with
   `MCP_TOKEN does not match any configured token.`
3. Restart the gateway (`npm start`) and/or reconnect the MCP client (`/mcp` in Claude Code).
4. Rotate the **DB** password separately (`ALTER ROLE … PASSWORD …`, a user action) and
   update `DS_<NAME>_PASSWORD`; the bearer and the DB credential are independent secrets.

### ⚠️ Trust boundary — schema caps, and how far they now reach

Since the relation guard, a token's `SCHEMAS` capability **is** enforced against the
relations a query actually references — not just the declared `schema` / `search_path`. A
token scoped to `public` now gets a **403** on `SELECT * FROM "other_tenant".t`, because the
guard parses the statement and checks every qualified relation against the caps (the same
`capabilityAllows` used for the declared schema). `SET LOCAL search_path` still guarantees
tenant isolation *between pooled borrowers* (the P0 invariant); the guard adds confinement
of the SQL body on top of it.

Two limits remain, so this is a strong app-layer boundary, **not** a database-enforced one:

- It holds only as long as the guard does — every query still runs as one shared
  `pg_read_all_data` role, and a **view** in an allowed schema can read across into a schema
  the token could not name directly.
- For a *hard* per-token boundary, enforce it in Postgres: a DB role per token with `USAGE`
  revoked on other schemas, or explicit per-schema grants
  ([`docs/runbooks/agent-ro-pg-role.md`](docs/runbooks/agent-ro-pg-role.md)). That is a
  deliberate follow-up, incompatible with the current single shared-pool topology.

### TLS note

When `SSL=true`, the client uses `rejectUnauthorized:false` (a typical TypeORM
config for managed Postgres with a self-signed chain) — this encrypts the connection but
does **not** authenticate the server. Provide a CA / set stricter TLS if MITM is in scope.

### search_path note

Only the target schema is put on `search_path` (not `public`), for isolation — so
references to shared `public` objects must be **fully qualified** (`public.foo`).
`pg_temp` is appended explicitly: when it is *absent* Postgres still searches it, and
searches it **first**, ahead of the tenant schema, for relation names — so a temp table
left on a pooled connection would shadow the next borrower's real table. Naming it
demotes it to last place.

### Why one statement per request is enforced twice

`assertSingleStatement` is a text scanner and text scanners lose. It previously missed
`E'…'` escape strings, where `\'` is an escaped quote rather than a terminator: the
scanner believed the literal was still open, swallowed the rest of the input, and let
`SELECT E'\''; COMMIT; <anything>` through. That smuggled `COMMIT` ended
`BEGIN TRANSACTION READ ONLY` and handed a **read-scoped token a read-write session** —
the read-only guarantee and the "defence in depth" guard were never independent, because
read-only lives on a transaction the caller could simply commit away.

The fix moves enforcement into the wire protocol. `pg` selects the protocol by whether
params were supplied — with none it uses the *simple* protocol, which executes `a; b`
from one call. `PostgresDriver.exec` now pins `queryMode:'extended'`, so Postgres answers
`cannot insert multiple commands into a prepared statement` regardless of what the
scanner thinks. The scanner is kept purely to fail such input earlier, as a 400, before
any DB contact. **Do not revert `exec` to the two-argument `client.query(sql, params)`
form** — that silently restores the simple protocol and the whole exploit chain.

## Known limitation

The row cap is enforced by fetching the result and slicing to `maxRows` (`truncated:true`
if exceeded), rather than a server-side cursor. For this trusted-caller utility that is
bounded in practice by `statement_timeout` + the row ceiling; a cursor-based bounded fetch
is a possible future optimization.
