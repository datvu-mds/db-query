---
phase: testing
title: Testing Strategy
description: Define testing approach, test cases, and quality assurance
---

# Testing Strategy

Feature: `multi-datasource-runtime`. Derived from the requirements' acceptance criteria and the design's
component breakdown and failure model.

## Test Coverage Goals
**What level of testing do we aim for?**

- **Unit**: 100% of new/changed code. Every branch of the two-stage failure model has a named case —
  this feature's whole value is that the failure paths behave, so an untested rejection path is a gap,
  not a nicety.
- **Integration**: real-Postgres coverage for pool swap/drain and probe-before-publish, following the
  existing `test/integration/*` skip-unless-configured pattern.
- **E2E**: full HTTP and MCP paths driven against `StubDriver`, as the existing suite does — no live DB.
- **Alignment**: each acceptance criterion in the requirements doc maps to at least one case below.

Conventions to follow: new files as `test/<subject>.test.ts`, `node:test` + `node:assert/strict`,
`StubDriver` / `CapturingAudit` / `makeConfig` from `test/helpers.ts`. Security-relevant regressions are
prefixed `SECURITY:` in their test name, matching the existing integration suite.

## Unit Tests
**What individual components need testing?**

### `config/datasources-dir.ts` — file reading, permissions, normalization · ✅ `test/datasources-dir.test.ts`, `test/env-file.test.ts` (33 cases)
- [x] Reads `*.env` only; `example.env.disabled` and other extensions are ignored
- [x] Filename stem becomes the datasource name, lowercased
- [x] Rejects a filename that is not `/^[a-z0-9_-]+$/`, naming the file
- [x] SECURITY: refuses a file with mode `644`, and the error names both the file and the `chmod 600` fix
- [x] SECURITY: refuses group- or other-readable modes generally (`640`, `604`, `660`)
- [x] Accepts mode `600` and `400`
- [x] Bare keys normalize to `DS_<NAME>_*` (`HOST` → `DS_WAREHOUSE_HOST`)
- [x] SECURITY: rejects a key that is not a known datasource field — a stray `TOKENS=` in a datasource file cannot widen grants
- [x] Comments and blank lines are skipped; `KEY=value with spaces` preserved; `KEY=` treated as empty ⇒ zod default applies
- [x] Missing `datasources.d/` directory is not an error (feature is opt-in)
- [x] Directory resolves CWD-relative by default and honours `DATASOURCES_DIR`

### `config/load-config.ts` — injected source · ✅ `test/load-config.test.ts`
- [x] `loadConfig(source)` reads the injected map, not `process.env`
- [x] Defaults to `process.env` when no source passed (backward compatible)
- [x] Existing behaviours still hold under injection: `DATABASE_*` fallback datasource, token cross-reference failure, `boolSecureDefault` asymmetry

### `config.schema.ts` + loaders — the `writable` field · ✅ `test/load-config.test.ts`
- [x] `writable` is required; a config object omitting it fails to parse
- [x] ~~`.env` `DS_X_WRITABLE` absent ⇒ `true` (backward compatible)~~ **SUPERSEDED** — absent ⇒ `false`
- [x] `.env` `DS_X_WRITABLE=false` ⇒ `false`
- [x] `datasources.d/` `WRITABLE` absent ⇒ `false` (fail-closed)
- [x] `datasources.d/` `WRITABLE=true` ⇒ `true`
- [x] ~~`DATABASE_*` fallback datasource ⇒ `true`~~ **SUPERSEDED** — ⇒ `false`
- [x] **SCOPE CHANGE — `writable` now fails closed from EVERY source.** Requested mid-implementation on the
      grounds that read-only is this gateway's headline invariant, so no source may make a datasource
      writable by omission. The per-source asymmetry is gone, and with it `LoadOptions.readOnlyByDefault`
      and the `writableDefault` parameter — one unconditional default in one place cannot be reopened by
      getting a call site wrong. The three cases above that asserted `true`-by-default now assert `false`
- [x] **DISCOVERED**: `WRITABLE` uses plain `bool()`, so a typo (`1`, `yes`, `on`) is NOT treated as true —
      the inverse of `SENSITIVE_RELATION_DENYLIST`, because writing is an opt-*in* to a dangerous
      capability rather than a safety net

### `config/reload.ts` — stage 1, validation is all-or-nothing · ✅ `test/reload.test.ts`
- [x] Valid reload publishes added datasources and returns a report of added/changed/removed
- [x] SECURITY: a name defined in both `.env` and `datasources.d/` refuses the whole reload, naming it
- [x] A zod failure anywhere leaves the previous config bit-for-bit unchanged
- [x] A token referencing an unknown datasource refuses the reload (existing cross-reference rule)
- [x] SECURITY: a reload removing the token the MCP process runs as is refused, naming the token id
- [x] SECURITY: a reload that rotates the MCP token's *secret* is refused too (identity re-authenticated against the candidate set, not matched by id)
- [x] SECURITY: `git check-ignore` reports `datasources.d/<name>.env` as ignored once `.gitignore` is
      updated, while `datasources.d/example.env.disabled` stays tracked · ✅ `test/gitignore.test.ts`
      (moved out of the reload group — it tests the repo, not the orchestrator).
      **DESIGN DEFECT FOUND AND CORRECTED**: the design specified `datasources.d/` plus a negation, but git
      cannot re-include a file whose parent directory is excluded, so that pattern silently swallows the
      template. Verified both ways with `git check-ignore`; shipped pattern is `datasources.d/*`
- [x] A bad-permission file refuses the reload; no partially-applied state
- [x] After any stage-1 refusal, `pools.names()` and token digests are identical to before

### `config/reload.ts` — stage 2, probes degrade per datasource · ✅ `test/reload.test.ts`
- [x] Added datasource is `ping`ed **and** posture-probed before it is published
- [x] `ping` failure withholds that datasource, logs it, and does **not** kill the process (contrast: boot exits 1)
- [x] A withheld datasource does not appear in `pools.names()` or `list_datasources`
- [x] Posture `WEAK` publishes with a warn — identical to boot
- [x] One datasource failing does not prevent a sibling in the same reload from publishing
- [x] Changed datasource builds a new pool, swaps, and drains the old one
- [x] SECURITY: a **changed** datasource is posture-probed too, not just `ping`ed — a credential swap from a read-only to a write-capable role must produce a `WEAK` warning, never a silent transition
- [x] Token grant edited in `.env` + reload changes that token's reachable datasources with no restart
- [x] Removed datasource stops routing and drains
- [x] A removed datasource disappears from `names()` immediately (new request → clean 400) but stays resolvable via `getConfig()`/`getPool()` until drain completes — a request that already passed `datasourceReady()` must not surface a 500
- [x] Reload log names added/removed/changed/withheld and contains **no** credential values
- [x] Posture is probed for added + changed **only** — an unaffected datasource is not re-probed (assert
      probe call count, so reload cost stays proportional to the diff) · ✅ `test/assert-readonly-posture.test.ts`
- [x] The WASM parser warm-up is skipped on reload (`warmParser: false`) but still runs at boot
- [x] **DISCOVERED — `only: []` must probe NOTHING.** The loop target uses `opts?.only ?? names()`, never a
      truthiness test; `||` would make an empty subset silently fall back to probing every datasource.
      Locked by its own case
- [x] **DISCOVERED**: a name in `only` that does not resolve logs `UNVERIFIED` and continues — it never
      throws out of a function contracted never to throw, is never silently skipped, and never claims OK.
      `only` is deliberately NOT filtered against `names()`, because reload probes STAGED datasources
- [x] **DISCOVERED — the warm-up assertion is only testable indirectly.** The warm-up has no observable
      effect on success (libpg-query starts its own WASM init at import time, so "the parser works" proves
      nothing), and the CJS→ESM named binding is snapshotted at first link. The test wraps `parse` via
      `createRequire` and dynamic-imports the module under test. **Invariant for future editors: no static
      import in that test file may reach libpg-query** — verified empirically, patch-before-link counts 1,
      patch-after-link counts 0. If one is added the assertion counts 0 and fails loudly
- [x] A changed `RootConfig`-backed boot-only key (`MAX_ROWS_CEILING`, `PORT`, `HOST`, `LOG_LEVEL`) is **not** applied and produces a warn naming the key
- [x] A changed `process.env`-only boot-only key (`HEALTH_CACHE_TTL_MS`, `ALLOW_PUBLIC_BIND`, `MCP_TRANSPORT`, `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `DATASOURCES_DIR`) also warns — compared against `process.env`, which production never mutates
- [x] An unchanged boot-only key produces no warn
- [x] Pool construction throwing for one datasource marks it withheld and does not abort the reload
- [x] **DISCOVERED (risk R9)**: overlapping SIGHUPs **coalesce** into one trailing reload — four triggers
      collapse to two reloads, never four. Queueing every signal would let a `kill -HUP` loop pile up
      unbounded work; dropping them would ignore an edit made during the window. A companion case proves
      the trailing run picks up a file written *during* the in-flight reload
- [x] **DISCOVERED — `withheld` must not be overloaded.** A post-swap posture failure on the CHANGED path
      leaves the datasource **serving** (ping, the actual gate, already passed), so reporting it as
      `withheld` would tell an operator the opposite of the truth. Split into a separate
      `postureUnverified` field; both are reported separately in the reload security log
- [x] **DISCOVERED — a no-op SIGHUP must churn nothing.** `report.changed` is `[]`, the pool object is
      IDENTICAL (asserted by identity, not equality — a rebuilt pool compares equal by value while having
      dropped every warm connection and re-run a 5s posture probe), and no posture line is emitted
- [x] **DISCOVERED — reload-test fixture trap, found by adding that assertion.** The `.env` a test writes
      must ROUND-TRIP the boot config exactly, or the boot datasource compares as `changed` on every single
      reload. `makeConfig()` sets `sensitiveRelationDenylist: false` while the zod default is `true`, and
      `logLevel: 'silent'` while the default is `'info'`. Until both were written into the fixture, `main`
      was permanently "changed" — the health-invalidation case passed for the wrong reason and the
      no-churn property was proven only at the `PoolManager` layer, never through `reloadConfig`
- [x] **DISCOVERED — assert credential non-leakage on the RIGHT line.** A blanket scan of every captured
      log also covers the posture log, which legitimately reports `db_user` at boot too — so a blanket
      assertion is either wrong or passes only by accident of the stub making the probe fail. Split:
      the reload security *event* is asserted to carry names only, while passwords and token secrets are
      asserted absent from every line. Probe values must also be UNAMBIGUOUS — the original test asserted
      on `postgres`, which was both the fixture's username and its password
- [x] **DISCOVERED — the collision check must run BEFORE the merge.** After merging into one source map
      the directory's `DS_<NAME>_*` keys have already overwritten `.env`'s, so the collision is invisible —
      which is exactly the silent credential override the check exists to prevent

### `pool/health-checker.ts` — cache invalidation · ✅ `test/health-checker.test.ts`
- [x] `invalidate(name)` drops the cached verdict so the next `check()` re-pings
- [x] A changed datasource does not serve its pre-swap verdict from cache after reload
- [x] An unaffected datasource keeps its cache entry (no needless re-ping)
- [x] **DISCOVERED — `invalidate()` alone is not sufficient.** A ping already IN FLIGHT against the *old*
      pool still runs `cache.set` when it settles, re-seeding the exact stale verdict `invalidate()` just
      dropped, for a full TTL. Fixed with a ping-identity guard (the promise object is the identity token)
      so an orphaned ping can neither re-seed the cache nor delete a newer ping's `inflight` entry.
      Regression case drives the pre-swap ping to fail and settle LAST, which is the only ordering that
      makes the bug observable

### MCP identity refresh (stdio) · ✅ `test/reload.test.ts`, `test/mcp-tools.test.ts`
- [x] After `applyTokens`, `Object.assign` onto the live caps makes an already-registered tool handler see the new datasource grants
- [x] A tool handler observes a complete capability set, never a half-updated one — `Object.assign`
      replaces the array references wholesale, and `capsById` returns freshly CLONED arrays so the live
      object can never alias into the token store
- [x] HTTP transport builds a new `McpServer` per session, so a session opened after reload gets fresh
      instructions — asserted structurally rather than by driving a session: `buildInstructions` is now
      exported and takes `(caps)`, so the per-session construction at `mcp-http.ts:119` is what supplies
      freshness. **Staleness is stdio-specific**, which is the point worth recording
- [x] **DISCOVERED — negative control for the identity refresh.** The same reload run *without* `liveCaps`
      leaves an already-registered handler blind to the new grant. Pairing it with the positive case
      localises a future break to the refresh itself rather than to the reload

### `pool/pool-manager.ts` — `applyDatasources` · ✅ `test/pool-manager.test.ts` (12 cases)
- [x] Adds a pool for a new datasource; `getConfig` returns the new config
- [x] Replaces a pool when credentials change and ends the previous one
- [x] Leaves an unchanged datasource's pool object identical (no needless churn)
- [x] Every newly created pool gets the mandatory `pool.on('error')` handler
- [x] `drainAll` still ends every pool after an apply
- [x] A removed datasource stays resolvable through its drain window (the R3 race)
- [x] **DISCOVERED (Design Decision 11)**: a STAGED datasource is resolvable via `getPool`/`getConfig` but
      absent from `names()` — asserted from *inside* the probe hook, which is the only place the window is
      observable
- [x] **DISCOVERED**: a probe failure on an added datasource fully retracts it — unpublished, pool ended,
      and no longer resolvable either, so no path can reach it
- [x] **DISCOVERED**: pool CONSTRUCTION throwing (a config `pg` rejects outright) withholds that one
      datasource and the apply continues past it
- [x] **DISCOVERED**: `applyDatasources` does NOT block on drains — a long in-flight query must not stall
      a reload, so the apply resolves while the removed pool is still draining
- [x] **DISCOVERED — the error-handler test was initially vacuous.** The first version overrode
      `createPool` in the test double, which is the very function that attaches `pool.on('error')`, so it
      asserted against the double rather than production code. Fixed by splitting `newPool` (the `pg`
      construction seam tests override) from `createPool` (which attaches the handler)

### `auth/token-auth.ts` — `applyTokens` / `capsById` · ✅ `test/token-auth.test.ts`
- [x] `applyTokens` makes a new token authenticate and a removed token stop authenticating
- [x] Constant-time comparison behaviour preserved after apply (all entries scanned, no early return) —
      pinned *behaviourally*, not by timing: with two entries sharing a secret the no-early-return loop
      makes the LAST one win, so an `if (!matched)` short-circuit fails the test
- [x] `capsById` returns caps for a known id and `null` for an unknown one
- [x] **DISCOVERED — alias hazard.** `capsById` must return cloned `datasources`/`schemas` arrays. The
      design's `Object.assign(liveCaps, capsById(id))` copies array *references* into an object every
      registered stdio handler holds for the process lifetime; without the clone a later mutation of live
      caps would silently widen the stored token's grants
- [x] **DISCOVERED**: `applyTokens([])` denies everyone, deliberately un-guarded — an `if (!next.length)
      return` "safety check" would leave previous grants live after an operator emptied them, i.e. fail open
- [x] **DISCOVERED**: no plaintext secret retention after apply, asserted via `JSON.stringify(auth)` (TS
      `private` is compile-time only, so this genuinely catches a retained `TokenConfig[]`)
- [x] **DISCOVERED**: an over-long presented secret returns `null` without throwing — `timingSafeEqual`
      throws on length mismatch, so this pins the fixed-length-digest comparison

### `query/query-service.ts` — the third write gate · ✅ `test/query-service.test.ts`
- [x] SECURITY: `write:true` against `writable:false` throws Forbidden (403) before any DB contact —
      asserted as `connectCount === 0` AND `sqls().length === 0` (no `BEGIN` either), not merely "it threw"
- [x] The rejection is audited, like every other guard rejection (entry keeps `write: true`, so a blocked
      write is distinguishable in the security stream)
- [x] `write:true` against `writable:true` with a write token proceeds — note `writable:true` is now
      always an EXPLICIT opt-in, never a default, on any config source
- [x] A read against `writable:false` is unaffected
- [x] `maxRowsCeiling` stays boot-only: the constructor signature is unchanged and a reload does **not**
      alter the clamp (design decision 9 — the warn path is covered in the `reload.ts` boot-only cases).
      *Caveat recorded:* the arity pin uses `Function.length`, which stops counting at the first optional
      parameter, so it would not catch a future `cfg?: RootConfig` being appended
- [x] **DISCOVERED**: the gate sits OUTSIDE the `allowUnsafeStatements` blocks. That escape hatch relaxes
      SQL *shape* guards and must never become a way to earn writes on a read-only datasource
- [x] **DISCOVERED**: the gate also precedes the `internal?.internalCatalogQuery` bypass, so it covers
      introspection and the boot probe too. Verified inert there — every internal `run()` caller passes
      `write: false` (`introspect-service.ts:57,72,87`, `assert-readonly-posture.ts:134`)

### `mcp/tools.ts` — `list_datasources` · ✅ `test/mcp-tools.test.ts`, `test/routes.e2e.test.ts`
- [x] Returns `{name, defaultSchema, writable}` for each permitted datasource
- [x] SECURITY: filtered by caps — a token cannot enumerate datasources outside its allow-list
- [x] Reflects a reload without the server being rebuilt — covers BOTH halves against handlers registered
      *before* the reload: `PoolManager` mutated in place, and live caps refreshed via `Object.assign`
      (the stdio identity-refresh path). An ungranted datasource stays hidden throughout, proving a reload
      widens visibility without bypassing the caps filter
- [x] `buildInstructions` no longer enumerates datasource names (signature narrowed to `(caps)` and
      exported, so the test reads it directly instead of poking SDK internals)
- [x] `list_datasources` and HTTP `GET /datasources` return the **same shape** for the same token —
      one structural `deepEqual`, with both transports resolving caps from the same real bearer token
- [x] **DISCOVERED — vacuous-pass guard.** The parity assertion is preceded by a check that the compared
      payload has >1 datasource and spans both `writable` values; otherwise two empty arrays would compare
      equal and the drift test would pass while proving nothing
- [x] **DISCOVERED**: `inputSchema: {}` must be stated explicitly rather than omitted — the MCP SDK
      switches handler arity on its presence

## Integration Tests
**How do we test component interactions?**

Extend `test/integration/pg.integration.test.ts` (skip-unless-configured via `PGCP_TEST_*`). **All five
ran GREEN against a live Postgres** (docker PG 18), not merely verified to skip:

- [x] Reload adds a real datasource: `ping` + posture probe both run against live Postgres before publish
- [x] Reload with an unreachable host withholds that datasource while the gateway keeps serving the healthy one
- [x] Credential change swaps the pool with no failed query during the swap
- [x] SECURITY: a real query against a `writable:false` datasource is rejected at the app layer even when the DB role can write
- [x] Removed datasource drains without cancelling an in-flight query

## End-to-End Tests
**What user flows need validation?**

Driven through `app.inject(...)` and the MCP tool handlers against `StubDriver`. Landed in a new
`test/reload.e2e.test.ts` (7 cases); `routes.e2e.test.ts` and `mcp-tools.test.ts` were left untouched.
Every case builds the app and registers the MCP tools **before** the reload — that is the whole point:

- [x] Operator flow: write file → reload → `POST /query` against the new datasource succeeds
- [x] Agent flow: `list_datasources` → `run_query` with the returned name succeeds in one session
- [x] Wildcard-token flow: `DATASOURCES=*` makes a new datasource usable with no `.env` edit
- [x] Explicit-grant flow: a token not granted the new datasource gets 403 (`datasource … not permitted`)
- [x] Regression: every existing route/tool behaviour unchanged when no `datasources.d/` exists
- [x] ~~Regression: `.env`-defined datasources keep today's write behaviour~~ **SUPERSEDED by the scope
      change** — that backward compatibility was removed deliberately. Reframed into the two halves it has
      become: an `.env` datasource with `WRITABLE=true` still writes end-to-end (`BEGIN` + `rowsAffected`),
      while a *silent* `.env` datasource and a `datasources.d/` one are both 403 `not writable` with
      `connectCount === 0`

## Test Data
**What data do we use for testing?**

- **Fixtures**: temporary `datasources.d/` directories under the OS temp dir, created per test with
  explicit `fs.chmodSync` so permission cases are exercised for real rather than mocked.
- **Mocks**: existing `StubDriver` (records exact `exec()` order, programmable `connectError` / `pingError`)
  and `CapturingAudit` (asserts rejections are audited). `makeConfig()` gains a `writable` field.
- **Injection**: `loadConfig(source)` takes a plain object, so no test mutates `process.env`.
- **Seed data**: integration tests reuse the existing throwaway `pgcp_test_a` / `pgcp_test_b` schemas.
- **Permission caveat**: if CI runs as root, mode checks may not behave as they do for a normal user —
  the permission tests should assert on the checking function's verdict given a stat mode, with one
  real-file test that skips when `process.getuid?.() === 0`.

## Test Reporting & Coverage
**How do we verify and communicate test results?**

- Run: `npm test` (full suite), or `node --import tsx --test test/reload.test.ts` for one file, or
  `--test-name-pattern="SECURITY:"` to run just the security regressions.
- **No coverage tooling is currently configured** — `package.json` has no coverage script and no
  reporter dependency. Node's built-in `--experimental-test-coverage` is the zero-dependency option and
  is **verified working** in this repo through `tsx`:
  `node --import tsx --test --experimental-test-coverage test/redact-error.test.ts` emits a per-file
  line/branch/function table. Adding it as a script is a planning-phase decision, not an assumption here.
- **Known static-analysis gap**: `npm run typecheck` excludes `test/` (tsconfig `include` is `src/**/*.ts`),
  and `tsx` strips types without checking them. Type errors in new test files surface only at runtime.
- Baseline was 222 tests, 207 pass / 15 skipped. **Now 378 tests, 378 pass / 0 fail** when configured
  against a live Postgres (`docker compose up -d` + `PGCP_TEST_*`), and 358 pass / 20 skipped unconfigured.
  The 20 skips are exactly the integration cases; nothing else skips.
- **50 `SECURITY:`-prefixed regressions** now run in the suite. Run just those with
  `--test-name-pattern="SECURITY:"`.
- **Phase-7 review added 39 tests to the suite (339 → 378)**, every one of them a regression for a defect
  that the 339 passing tests did not catch. That ratio is the useful number here: a green suite was not
  evidence of correctness for any of the twelve findings.

## Manual Testing
**What requires human validation?**

- Write a real `datasources.d/warehouse.env` against a second cluster, `kill -HUP`, confirm the log names
  it and that `list_datasources` shows it.
- Confirm a `chmod 644` file is refused with an actionable message.
- Confirm the reload log contains no password, host, or user values.
- Confirm the agent, mid-session in Claude Code, can call `list_datasources` and switch to the new
  datasource without reconnecting `/mcp`.
- **N/A**: UI/UX, accessibility, browser/device compatibility — this is a headless infra utility with no
  UI surface.

## Performance Testing
**How do we validate performance?**

- Formal load/stress testing is **N/A** for this trusted-infra utility; the existing suite has no
  performance harness and this feature adds no hot-path work beyond one boolean check.
- Two bounded assertions worth making instead:
  - [ ] Reload with N added datasources completes within roughly N × (`ping` + `PROBE_TIMEOUT_MS` 5000 worst case)
  - [ ] A reload issued while a query is in flight does not fail or delay that query

## Bug Tracking
**How do we manage issues?**

- No external issue tracker is configured in this repo. Defects found during this feature are recorded
  in the planning doc's blocker list and, when they represent a class of mistake worth remembering, as a
  writeup under `docs/journals/` — the convention already used for the statement-guard and relation-guard
  bypasses.
- **Severity**: anything that lets a credential escape a file, publishes an unprobed datasource, or lets
  a write reach a `writable:false` datasource is blocking. Ergonomic and logging defects are not.
- **Regression strategy**: every security defect found gets a `SECURITY:`-prefixed test before its fix,
  per the existing convention and the `tdd` skill.
