---
phase: requirements
title: Requirements & Problem Understanding
description: Clarify the problem space, gather requirements, and define success criteria
---

# Requirements & Problem Understanding

Feature: `multi-datasource-runtime` — branch `feature-multi-datasource-runtime`.

## Problem Statement
**What problem are we solving?**

The gateway's set of datasources is fixed at process start. `loadConfig()` reads `DATASOURCES` +
`DS_<NAME>_*` from `process.env` once, `PoolManager`'s constructor builds every pool from that list,
and neither exposes a way to add one later. Adding a database therefore costs an `.env` edit **and a
restart**.

Two consequences, both hit in normal use:

- **Operator.** A database on a *different cluster* (its own host / role / password) cannot be
  introduced into a running gateway. The HTTP gateway is long-running, so a restart drops in-flight
  queries and warm pools.
- **Agent.** Over MCP there is no way to discover what exists. `/datasources` is HTTP-only; the MCP
  adapter's sole signal is the `instructions` string, which `buildInstructions()` snapshots at server
  construction and clients cache from initialization. A datasource added mid-session is invisible to
  the agent even once it is usable.

**Not the problem:** multi-datasource support itself. `DATASOURCES=main,analytics` already builds a
pool each, and `datasource` is a per-call argument on both `/query` and `run_query` — *switching*
between already-configured datasources works today. The gap is registration without a restart, plus
discovery over MCP.

**Affected:** the operator running the gateway (holds all credentials), and the agent consuming it
through MCP.

**Current workaround:** edit `.env`, restart the process. For stdio MCP under Claude Code, reconnecting
`/mcp` restarts the process incidentally — which is why this pain is sharpest on the long-running HTTP
gateway.

## Goals & Objectives
**What do we want to achieve?**

**Primary goals**

1. An operator can register a datasource on any cluster by dropping one file into `datasources.d/`
   and signalling the running process — no restart, no `.env` edit required for the datasource itself.
2. Credentials never cross a request boundary. The registration path stays operator-only; no tool,
   endpoint, or agent-reachable surface ever accepts a password.
3. A newly registered datasource is subject to the identical guard, probe, and audit treatment a
   boot-time datasource gets — no datasource enters service unprobed.
4. The agent can enumerate currently-usable datasources over MCP and switch to one within a session.

**Secondary goals**

5. Reduce credential exposure at rest: per-datasource files with enforced `600` permissions instead
   of one flat `.env` holding everything.
6. Token grants become editable without a restart, so a datasource can be scoped to specific tokens
   rather than forcing a `DATASOURCES=*` wildcard.

**Non-goals (explicitly out of scope)**

- **No CLI.** Files are hand-authored. (Dropped deliberately during brainstorm.)
- **No agent-supplied credentials.** An MCP tool taking host/user/password would place a secret in the
  model's context window, the MCP transcript, and any shared conversation — inverting the boundary
  `redact-error.ts` exists to enforce. Rejected on principle, not effort.
- **No secret-store indirection** (Vault / 1Password / IAM auth tokens). `pg` supports an async
  `password` function (`node_modules/pg/lib/client.js:269-289`) making this a cheap later layer, but
  it is not in this scope.
- **No encryption at rest** (sops/age). Later layer.
- **No same-cluster multi-database shortcut.** Considered and set aside: the databases here are on
  different clusters, so a `database`-per-pool reuse of one credential does not cover the need.
- **No per-token DB roles.** The hard, database-enforced per-token boundary remains the deliberate
  follow-up already documented in README §Trust boundary.

## User Stories & Use Cases
**How will users interact with the solution?**

- As an **operator**, I want to add a datasource on a different cluster by writing one file and sending
  one signal, so that I don't restart a gateway serving live queries.
- As an **operator**, I want a datasource to be read-only unless I explicitly say otherwise, so that a
  newly added database cannot be written to before I've reviewed it.
- As an **operator**, I want a malformed or wrongly-permissioned file to change nothing, so that a typo
  never takes down a working gateway.
- As an **agent**, I want to list the datasources I may currently use, so that I can switch to one the
  operator added after my session began.

**Key workflows**

*Register (explicit grants)*
1. Write `datasources.d/warehouse.env` (mode `600`).
2. Edit `.env`: `TOKEN_AGENT_RO_DATASOURCES=main,warehouse`.
3. `kill -HUP <pid>`.

*Register (wildcard token)*
1. Write `datasources.d/warehouse.env` (mode `600`).
2. `kill -HUP <pid>`.

*Consume* — agent calls `list_datasources`, sees `warehouse`, passes `datasource: "warehouse"` to
`run_query` / `list_schemas` / `list_tables` / `describe_table`.

**Edge cases to consider**

- File mode is `644` (default umask) → refused, with the `chmod` command named.
- A name defined in both `.env` and `datasources.d/` → reload refused entirely.
- New datasource unreachable (`ping` fails) → not published; server keeps running.
- New datasource reachable but posture `WEAK` → published, warned; writes still blocked absent `WRITABLE=true`.
- A reload that would remove — or rotate the secret of — the token the MCP process runs as → refused at validation.
- A `datasources.d/` credential file must not be committable; `.gitignore` does not cover it today (verified).
- Datasource file deleted → pool drains after in-flight queries complete.
- Credentials rotated in place → new pool built alongside, swapped, old pool drained.
- Reload arrives while queries are in flight → in-flight queries finish on their existing connections.

## Success Criteria
**How will we know when we're done?**

**Acceptance criteria**

1. Writing `datasources.d/<name>.env` + SIGHUP makes `<name>` usable with no restart, on a cluster
   unrelated to any `.env` datasource.
2. No credential appears in any request, response, tool schema, tool result, or MCP transcript. The
   only credential inputs remain operator-controlled files.
3. Every added or changed datasource runs `pools.ping()` **and** `assertReadOnlyPosture()` before it is
   published, and both outcomes are logged.
4. An invalid reload (bad permissions, unparseable file, zod failure, name collision, MCP-identity
   invalidation) leaves the previously running config **completely** unchanged, and says why.
5. A `datasources.d/` datasource rejects writes with 403 unless its file sets `WRITABLE=true` — even
   for a write-mode token passing `readOnly:false`. Boot and reload apply this identically.
6. `list_datasources` returns the caps-filtered list over MCP as `{name, defaultSchema, writable}`, and
   reflects a reload without the client reconnecting.
7. Existing `.env` `DS_*` datasources and their write behaviour are unchanged (backward compatible).
8. Reload is logged as a security event naming what was added / removed / changed / withheld — names
   only, never values.
9. A `datasources.d/` file that is not mode `600` (or stricter) is refused, and the error names both the
   file and the `chmod` fix. *(traces goal 5)*
10. Editing `TOKEN_<ID>_DATASOURCES` in `.env` + SIGHUP changes that token's reachable datasources with
    no restart, so scoping does not require a `DATASOURCES=*` wildcard. *(traces goal 6)*
11. `git check-ignore` reports `datasources.d/<name>.env` as ignored, while the in-directory template
    `datasources.d/example.env.disabled` remains tracked.

**Measurable outcomes**

- Full suite green (`npm test`), typecheck clean, no reduction in the 15 integration tests.
- New unit coverage for each edge case listed above.

**Performance**

- Reload completes in roughly the time of one `ping` + one posture probe per added datasource
  (`PROBE_TIMEOUT_MS` is 5000 per datasource); it must not block or fail in-flight queries.

## Constraints & Assumptions
**What limitations do we need to work within?**

**Technical constraints**

- `loadConfig()` reads `process.env` directly, but `--env-file-if-exists=.env` only populates it at
  process start — so reload cannot go through `process.env`. `loadConfig` must accept an injected
  source map.
- `load-config.ts:117-124` hard-fails when a token references an unknown datasource; the merged config
  must satisfy this at validation time.
- `PoolManager` and `TokenAuth` build their state in constructors; routes and MCP tools capture the
  `Services` object by reference at registration, so reload must mutate in place rather than rebuild.
- `QueryService` receives `maxRowsCeiling` by value at construction and has **7 construction sites**
  (1 src, 6 test), so making the row clamp reloadable is not free. Resolved in Phase 3: it stays
  boot-only and reload warns when a boot-only key changes (design decision 9).
- The MCP process resolves `caps` once from `MCP_TOKEN` at boot and both `createMcpServer` and
  `registerTools` capture it.
- Guard defaults must be produced by `datasourceSchema.parse()`, never a hand-built object, or
  `boolSecureDefault()`'s fail-closed asymmetry is silently bypassed for exactly the datasources with
  the least review.
- Node's `fs.watch` is inconsistent across platforms and fires on partial writes — hence an explicit
  signal rather than a watcher.
- **SIGHUP is POSIX-only.** Node on Windows does not deliver it, so reload is unavailable there and
  Windows keeps the restart workflow. The repo has no Windows support story today (dev and deploy are
  darwin/linux), so this is a documented limitation rather than a gap to close.
- `datasources.d/` is resolved **relative to the process CWD**, matching how `--env-file-if-exists=.env`
  already resolves `.env`, and overridable with `DATASOURCES_DIR`. A missing directory is not an error —
  the feature is opt-in and the gateway must still boot on a config that predates it.

**Business/operational constraints**

- Single-operator or small-team, trusted-infra deployment (loopback binds by default).
- Credential secrecy is the top-priority requirement, above ergonomics.

**Assumptions**

- The operator already holds credentials for every cluster to be added (stated).
- Databases may be on different clusters; a same-cluster shortcut does not cover the need (stated).
- Registration is operator-initiated; the agent only consumes (stated).
- Posture `WEAK` remains observability-only. It is definitionally true of any working write datasource
  (`assert-readonly-posture.ts:225`), so it cannot gate writes.
- On stdio MCP, reconnecting `/mcp` already reloads config incidentally; SIGHUP is the path that
  preserves session context. The long-running HTTP gateway is where reload is strictly required.

## Questions & Open Items
**What do we still need to clarify?**

All material questions were resolved before this document was written:

| Question | Resolution |
|---|---|
| What does reload re-read, and how do grants reach a new datasource? | `.env` **+** `datasources.d/` merged; tokens reload; MCP caps re-resolved by id |
| Key shape for `datasources.d/*.env`? | Bare keys, name from filename, normalized to `DS_<NAME>_*` internally |
| Name defined in both sources? | Reload refused, name reported — no silent credential override |
| Newly added datasource with posture `WEAK`? | Published + warned; writes gated by explicit `WRITABLE=true` instead |
| Should the `WEAK` verdict gate writes directly? | No — it is true of every write datasource, so it would kill writes entirely |

**Resolved during Phase 2 review** (recorded here rather than left implicit):

| Question | Resolution |
|---|---|
| Is posture re-probed when a datasource's credentials *change*, or only when one is added? | **Both.** New credentials can mean a different role with different grants, so a change must re-probe or a swap could silently move a datasource from `OK` to `WEAK` unlogged. Design and testing docs corrected to match acceptance criterion 3. |
| Where does `datasources.d/` live? | CWD-relative, mirroring `.env`; `DATASOURCES_DIR` overrides; missing directory is not an error |
| What happens on Windows, where SIGHUP is undeliverable? | Reload unavailable; restart workflow retained. Documented limitation, not a gap |

**Resolved during Phase 3 design review** (feasibility findings against the real code):

| Question | Resolution |
|---|---|
| Is a `ConfigStore` class needed to make config live? | No. `services.config` has exactly one reader (`assert-readonly-posture.ts:210`), so a field reassignment suffices |
| Should `MAX_ROWS_CEILING` follow a reload? | No — boot-only, but reload **compares boot-only keys and warns** when one changed, so nothing no-ops silently |
| Does `HealthChecker` follow a pool swap? | Yes for the pool itself, but its per-datasource TTL cache (5000ms) would serve a stale verdict for a *changed* datasource — needs `invalidate()` |
| Does reload re-probe every datasource? | It must not. `assertReadOnlyPosture` gains `{ only, warmParser }` so reload cost is proportional to what changed, not to total datasource count |
| How does the stdio MCP process pick up refreshed capabilities? | `Object.assign` onto the live `caps` object that `registerTools` closed over; stage 1 guarantees it still resolves |
| Are cached MCP `instructions` stale on both transports? | Only stdio. `mcp-http.ts:119` builds a new `McpServer` per session, so HTTP sessions get fresh instructions after a reload |

**Deferred (named, not blocking)**

- Secret-store indirection via `pg`'s async `password` function.
- Encryption at rest for `datasources.d/`.
- An opt-in file watcher, cheap to add later precisely because reload is atomic-or-nothing.
- Re-resolving MCP `instructions` after reload — the SDK caches them client-side; `list_datasources`
  is the agreed mitigation.

**Requires operator action, never automated**

- Creating read-only Postgres roles per `docs/runbooks/agent-ro-pg-role.md`.
- Setting `600` on the files themselves.
