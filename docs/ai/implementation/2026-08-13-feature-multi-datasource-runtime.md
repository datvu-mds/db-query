---
phase: implementation
title: Implementation Guide
description: Technical implementation notes, patterns, and code guidelines
---

# Implementation Guide

Feature: `multi-datasource-runtime`, branch `feature-multi-datasource-runtime`.
Sources: [requirements](../requirements/2026-08-13-feature-multi-datasource-runtime.md) ·
[design](../design/2026-08-13-feature-multi-datasource-runtime.md) ·
[planning](../planning/2026-08-13-feature-multi-datasource-runtime.md) ·
[testing](../testing/2026-08-13-feature-multi-datasource-runtime.md).

This records what actually shipped, and specifically where it **differs** from the design. The design doc
is the intent; this is the reality.

Three kinds of divergence are recorded below, and the distinction matters when reconciling them:

1. **Design statements that were wrong in practice** — the stage-2 probe sequence (Design Decision 11) and
   the `.gitignore` pattern. Both were **corrected in the design doc**, so design and code agree.
2. **A scope change requested mid-implementation** — `writable` fails closed from every source. Per
   explicit instruction the design doc was **left as-is**, so it disagrees with the code on that one
   point; the ⚠️ box below is authoritative.
3. **Limitations found while building** — documented rather than worked around (see the reload section).

## Development Setup
**How do we get started?**

No new dependencies (design decision: `node:fs` + `statSync().mode` suffice). Existing toolchain only.

```bash
npm test                 # full suite
npm run typecheck:all    # NEW — src AND test (see "Closing the typecheck gap")
node --import tsx --test test/pool-manager.test.ts   # one file
node --import tsx --test --test-name-pattern="SECURITY:" "test/**/*.test.ts"
```

To exercise the feature by hand:

```bash
cp datasources.d/example.env.disabled datasources.d/warehouse.env
chmod 600 datasources.d/warehouse.env     # ENFORCED — the loader refuses otherwise
kill -HUP $(pgrep -f dist/server.js)
```

## Code Structure
**How is the code organized?**

**New files**

| File | Role |
|---|---|
| `src/config/config-sources.ts` | **The config entry point.** `gatherConfigSources()` merges every source; `resolveConfig()` is what both entrypoints call |
| `src/config/env-file.ts` | The ONE env-file parser, two dialects (see "One parser, two dialects") |
| `src/config/datasources-dir.ts` | Read `datasources.d/*.env`, enforce mode 600, filename→name, bare-key normalization |
| `src/config/reload.ts` | The two-stage reload orchestrator |
| `tsconfig.test.json` | Type-checks `test/**` (see "Closing the typecheck gap") |
| `datasources.d/example.env.disabled` | In-directory template; never loaded (`*.env` only) |

**Modified**: `config/load-config.ts`, `config/config.schema.ts`, `pool/pool-manager.ts`,
`pool/health-checker.ts`, `auth/token-auth.ts`, `boot/assert-readonly-posture.ts`,
`query/query-service.ts`, `mcp/tools.ts`, `mcp/create-mcp-server.ts`, `routes/datasources.route.ts`,
`server.ts`, `mcp/mcp-server.ts`, `routes/health.route.ts`, `.gitignore`, `package.json`.

## Implementation Notes
**Key technical details to remember:**

### `loadConfig(source)` — the seam the feature hangs on

`loadConfig()` no longer reads `process.env` directly; it takes an env-shaped source map, defaulting to
`process.env` so every existing caller is unchanged. Reload needs to validate a **candidate** config
merged from `.env` + `datasources.d/*.env` **without mutating the live process environment** — otherwise a
*rejected* reload would leave debris behind, and stage 1's "leaves the previous config bit-for-bit
unchanged" guarantee would be a lie.

That `process.env` is never written by production code is also what makes it a valid comparison baseline
for the boot-only keys zod never sees (`HEALTH_CACHE_TTL_MS`, `ALLOW_PUBLIC_BIND`, `MCP_TRANSPORT`, …).

### `writable` — required in the schema, fail-closed from EVERY source

> ## ⚠️ SCOPE CHANGE — supersedes design decision 3 and the design's per-source `writable` table
>
> **Requested mid-implementation**, on the grounds that read-only is this gateway's headline invariant and
> the shipped defaults were violating it. `writable` now defaults to **`false` from every config source** —
> `.env`, `datasources.d/`, and the `DATABASE_*` fallback alike — and no shipped example configures a
> write-capable token.
>
> **Per explicit instruction, the requirements/design/planning docs were left describing the original
> per-source design; this section is the record.** So design decision 3 and the design's `writable` table
> (`.env` ⇒ `?? true`, `DATABASE_*` ⇒ `?? true`) now disagree with the code **on the default direction
> only**. Everything else about the gate — required in the schema, enforced at the `QueryService` choke
> point, `bool()` not `boolSecureDefault()` — is unchanged and still matches. Anyone reconciling design
> against code should treat this box as authoritative for defaults.
>
> **The write capability itself was NOT removed.** Writes remain possible; they now require three
> independent opt-ins, none of them on by default.

`datasourceSchema.writable` has **no zod default** — that part is unchanged and load-bearing. Requiring it
means every literal `DatasourceConfig` construction site must state its intent, which is compiler-enforced
(and, thanks to `typecheck:test`, enforced in `test/` too).

**What the scope change deleted.** With all three sources defaulting the same way, the per-source
asymmetry had nothing left to express, so `LoadOptions.readOnlyByDefault` and the `writableDefault`
parameter of `buildDatasource()` were removed rather than left as machinery every caller sets to `false`.
`loadConfig(source)` is back to a single parameter. This is *stronger*, not merely tidier: one
unconditional default in one place cannot be reopened by getting a call site wrong, whereas three
coordinated defaults were three chances to reintroduce a fail-open path.

`WRITABLE` uses plain `bool()`, not `boolSecureDefault()` — the deliberate inverse of
`SENSITIVE_RELATION_DENYLIST`. Writing is an opt-**in** to a dangerous capability, so only an exact
`"true"` grants it and any typo stays read-only; the secure-by-default converter is for safety *nets*,
where a typo must keep the net *on*. Both conventions converge on the same rule: **a mistake leaves you
safer.**

**Boot announces it.** `assert-readonly-posture.ts` now emits a WARN naming every writable datasource, in
the same register as the `ALLOW_UNSAFE_STATEMENTS` warning. A deliberate act that re-opens a write path
should be visible on every boot, not recorded only in a `.env` nobody re-reads. The default path stays
quiet — if the common case were noisy, operators would learn to ignore the line that matters.

**The three write gates, after the change:**

| # | Gate | Default | Enforced in |
|---|---|---|---|
| 1 | write-mode token | `read`; `.env.example` ships no write token | `TokenAuth.authorize` |
| 2 | datasource is writable | `false`, every source | `QueryService.run` |
| 3 | request opts in | `readOnly: true` | `TokenAuth.authorize` |

### Routable vs resolvable — Design Decision 11

**The design's stage-2 sequence was not expressible as written**, and this is the one substantive
correction the implementation forced.

`assertReadOnlyPosture` probes *through* `queryService` → `driver.connect(name)` → `pools.getPool(name)`.
So "probe the candidate before publishing it" cannot be expressed while one name maps to one pool — the
probe reaches whatever `getPool` already returns. `PoolManager` therefore separates the two properties:

- `names()` → the **routable** set
- `getPool()` / `getConfig()` → routable ∪ **staged** ∪ **draining**

**This is safe only because every request path gates on `names()` before it resolves a pool.** Verified by
grep, and the invariant to re-check before touching any of it: `route-helpers.ts:36` (`datasourceReady`,
covering `/query` and all three `/introspect/*` routes), `mcp/tools.ts:33` and `:94` (every MCP tool),
`health.route.ts:12`, `datasources.route.ts:14`.

The three diff paths are deliberately asymmetric, which is why `ApplyHooks` has **two** probe callbacks
rather than one:

| Path | Sequence | Probe failure |
|---|---|---|
| added | stage → `ping` → `probeAdded` → publish | withheld, pool ended, fully retracted |
| changed | build candidate → ping the **candidate object** → swap → `probeChanged` → drain old | recorded; swap stands |
| removed | unroute → keep resolvable → `end()` → delete | n/a |

On the `changed` path a request arriving between swap and posture uses a pool that has been *pinged* but
not yet *posture-probed*. That is sound because **posture never gates, it observes** — per Design Decision
4 every working write datasource reports `WEAK`, so no publish decision has ever keyed on it. `ping` is
the gate, and ping precedes the swap.

`createPool` is split from `newPool`: `newPool` is the `pg` construction seam tests override, `createPool`
attaches the mandatory `pool.on('error')`. Overriding the whole of `createPool` in tests would have made
the "every pool has an error handler" assertion test the double instead of the real thing — the first
version of that test passed vacuously until the split.

**Change detection is a full deep-compare** (`isDeepStrictEqual`), so *any* field difference counts as
changed. Deliberately conservative: distinguishing "pool-affecting" from "policy-only" edits would create
two paths where one silently skips the probe. Cost is a needless ping + posture probe on a
`deniedTables`-only edit; that is a reload-latency cost, never a correctness one.

**The apply does not block on drains.** `removeDatasource` fires the drain and returns, so a long
in-flight query cannot stall a reload. `drainAll()` covers mid-drain pools via a `draining` set, so
shutdown still ends everything.

### One parser, two dialects

The repo has **no in-process dotenv** — `.env` is loaded only by `node --env-file-if-exists=.env`. But
`reload.ts` must parse `.env` itself and `datasources-dir.ts` must parse its own files. Both go through
`src/config/env-file.ts`. Two *parsers* with different quoting semantics is precisely the "shared
definitions that must not drift" failure `CLAUDE.md` warns about — the same class as
`banned-functions.ts`, `isSystemSchema`, `capabilityAllows`, and `stripToCode`.

**One parser, two dialects** *(phase-7 correction)*. The asymmetry is per-CONSUMER and is the whole point:
`.env` answers to node, which also parses it at boot, so there the only safe rule is *match node exactly*.
`datasources.d/` answers to nothing else, so there the credential-safe rules apply — `#` is literal (never
truncate a password at a hash), no escape expansion, BOM stripped.

Phase-7 review found **five** divergences where the two parsers disagreed about the same `.env` file:
inline `#`, backticks-as-quotes, multi-line quoted values, BOM, and `\n` expansion inside double quotes.
Each produced permanent pool churn — an *unchanged* `.env` compares as changed on every reload, forever —
and the multi-line case was worse: text inside what node treats as one quoted string became a **real
top-level key** on reload, so a `TOKEN_*_SECRET` boot never saw could become a live credential.

The dialects now share the quoted-value **span** step and differ only on whether to accept it, which is
what makes inner lines impossible to promote. Two divergences from node are kept deliberately in both
dialects (a stricter key charset, and `export` stripped only before spaces) — both can only ever *drop* a
key, never invent one, which is the direction that matters. Verified by a differential run against real
node over 400 randomized files: **0 invented keys, 0 value mismatches**.

### Reload orchestration and SIGHUP serialization

`reloadConfig(services, opts)` returns a `ReloadReport` and is contracted **never to throw**.
`createReloadRunner()` wraps it with **coalescing** serialization (risk R9): a signal arriving while a
reload is in flight sets a single pending flag, and exactly one more reload runs afterwards no matter how
many signals landed. Queueing every signal would let `while true; do kill -HUP $pid; done` pile up
unbounded work; dropping them outright would ignore an edit the operator made during the window. One
trailing run applies the latest state on disk, which is what they meant. `installReloadOnSighup()` returns
the runner so shutdown can `await reloader.idle()` before draining — ending pools underneath an in-flight
swap would strand a half-applied config on the way out.

Two ordering decisions inside stage 2 that are not arbitrary:

1. **`applyTokens` and `services.config = next` happen BEFORE `applyDatasources`.** The posture probe
   reads `services.config.tokens` to report which write tokens can reach a datasource; probing first would
   log the *old* token set. The cost is a window where a token is granted a not-yet-published datasource —
   harmless, since that request gets a clean 400 from `datasourceReady()`.
2. **The boot-only comparison happens BEFORE `services.config` is reassigned.** Afterwards the old values
   are gone and the diff is unrecoverable.

**Known limitation, documented in the README rather than worked around.** The merged candidate is
`{...baseEnv, ...parsed(.env), ...normalized(datasources.d)}`, and node loaded `.env` into the environment
at boot — so a key **deleted** from `.env` since boot is not unset by a reload; its boot value survives in
`baseEnv`. Changing a value works; removing one entirely needs a restart. Fixing this would mean tracking
which env keys originated from `.env` at boot, which the process cannot observe after the fact.

### The third write gate

`QueryService.run()` gains `if (input.write && !dsCfg.writable) → ForbiddenError`, audited, placed
immediately after the single-statement scan and before any DB contact. It is a boolean check, so it
belongs ahead of the text and parse-tree guards. The **constructor is unchanged** (Design Decision 9), so
none of its 7 construction sites were touched.

This is the *third* gate. The first two — write-mode token, explicit `readOnly:false` — live in
`TokenAuth.authorize`. This one is per-datasource and lives at the choke point so HTTP, MCP and
introspection are all covered by one check.

Not keyed on the posture verdict: `assert-readonly-posture.ts:225` reports `WEAK` for any role that can
write, i.e. every working write datasource, so gating on it would make writes impossible everywhere.

### Closing the typecheck gap — done FIRST, not last

Planning put this in Phase 4. It was pulled forward to immediately after task 1.2, because making
`writable` required has a blast radius that is *entirely typed literal sites in `test/`* — the one place
type errors were invisible (`tsconfig` excludes `test/`; `tsx` strips types without checking them).
Running it afterwards would have left the sweep unverified.

The payoff was immediate: the compiler reported **exactly** the two sites risk R1 predicted
(`test/helpers.ts`, `test/integration/pg.integration.test.ts`) — turning "the sweep found two" into "the
compiler confirmed two". The one pre-existing error R2 documented was also fixed.

`tsconfig.test.json` must widen `rootDir` to `.`; the base config pins it to `src`, which errors as soon
as a `test/**` file enters the program.

### `.gitignore` — the design doc's pattern did not work

> **Correction to the design doc, verified empirically.** It specified `datasources.d/` plus a
> `!datasources.d/example.env.disabled` negation. **Git cannot re-include a file whose parent directory is
> excluded**, so that combination ignores the template too — the negation is dead. Confirmed both ways
> with `git check-ignore` in a scratch repo. The shipped pattern is `datasources.d/*`.

This matters more than a typo: the template is the only in-repo documentation of the bare-key file shape,
and it would have vanished from the working tree with no error.

## Integration Points
**How do pieces connect?**

- **SIGHUP → `reloadConfig(services, …)`** on both entrypoints, serialized so overlapping signals cannot
  interleave two reloads.
- **`reload.ts` → `PoolManager.applyDatasources(next, hooks)`** — the hooks are how the posture probe is
  injected at the one moment each path can still act on it.
- **stdio MCP identity** — `Object.assign(liveCaps, capsById(id))` after `applyTokens`. `registerTools`
  closes over the caps **object**, so an in-place field update reaches every already-registered handler.
  `Object.assign` replaces array references wholesale, so no handler sees a half-updated capability set.
- **Instruction staleness is stdio-specific** — `mcp-http.ts:119` builds a new `McpServer` per session, so
  any streamable-HTTP session opened after a reload already gets fresh instructions.

## Error Handling
**How do we handle failures?**

The two-stage failure model is the feature:

- **Stage 1 (validation) is all-or-nothing.** Permissions, parse, zod, cross-source name collision, and
  the MCP identity re-authentication. Any failure logs and returns with the running config untouched.
- **Stage 2 (probes) degrades per datasource.** The server never dies here. The only sanctioned divergence
  between boot and reload: a `ping` failure is **fatal at boot** (nothing is serving yet) and **withheld
  on reload** (something is).

Caller-facing error text goes through `redactErrorMessage`; full detail stays in the server-side audit
log. Reload logs names added/removed/changed/withheld and **never values**.

## Performance Considerations
**How do we keep it fast?**

- Steady-state query path adds exactly one boolean check (`dsCfg.writable`) inside an existing config
  lookup. No added allocation or I/O.
- Reload cost is proportional to the **diff**, not to total datasource count —
  `assertReadOnlyPosture(services, id, { only, warmParser: false })`. Asserted by probe-call-count tests so
  a regression fails a test rather than just being slow.
- The WASM parser warm-up is skipped on reload (already warm) and still runs at boot.

## Security Notes
**What security measures are in place?**

- **Credentials enter through operator-controlled files only.** No tool schema, endpoint, or
  agent-reachable surface accepts one. An `add_datasource`-style tool is a non-goal on principle.
- **Mode 600 enforced**, with the `chmod` fix named in the error. With no CLI to set the mode, this check
  is the only thing between a default-umask file and a world-readable password.
- **Unknown keys rejected** in datasource files — a stray `TOKENS=` cannot widen anyone's grants.
- **Fail-closed everywhere**: `writable` defaults false for **every** datasource from every source, a
  cross-source name collision refuses the whole reload, an unparseable file changes nothing.
- **No datasource is ever published unprobed** — the staging mechanism above is what makes that true
  rather than aspirational.
- **MCP identity is re-authenticated against the candidate token set**, not matched by id — so a *rotated
  secret* is caught as well as a removed token. Either would leave a live process unable to authorize its
  own tool calls.
- Every rejection is **audited before it throws**; blocked attempts must appear in the security stream.

---

# Phase 7 — Check Implementation: review findings

Three independent reviews (acceptance-criteria alignment, security, correctness/edge-cases) were run against
the completed implementation. The suite was green throughout — **every finding below is something 339
passing tests did not catch.** Findings marked ✅ *reproduced* were confirmed by executing the real code,
not by reading it.

## Alignment summary

8 of 11 acceptance criteria cleanly MET. Criteria 3 and 11 are letter/intent splits; criterion 7 is
knowingly NOT MET (the write-hardening scope change). Measurable outcomes hold: suite green, both
typechecks clean, and the integration count went **up** 15 → 20 with zero removals.

## Defects found

| # | Sev | Finding | Where |
|---|---|---|---|
| 1 | **CRITICAL** ✅ | **Boot never reads `datasources.d/`.** Both entrypoints call bare `loadConfig()`; the directory is imported only by `reload.ts`. A directory datasource exists only after SIGHUP and only for that process lifetime. On restart it silently vanishes (wildcard token) or **hard-fails boot** with `Token "X" references unknown datasource` — an error pointing at the token, not the unread directory. Makes `README.md`'s Windows guidance ("restart instead") false, and is the strongest possible violation of Design Decision 6 | `server.ts:15`, `mcp-server.ts:20` |
| 2 | **HIGH** ✅ | **The first `datasources.d/` file silently deletes the `DATABASE_*` fallback datasource.** The fallback fires only when `DATASOURCES` is empty, but reload sets it unconditionally. A zero-config deployment + wildcard token: operator adds one datasource and loses their primary one (`added:['warehouse'], removed:['main']`) | `reload.ts:249` vs `load-config.ts:129` |
| 3 | **HIGH** ✅ | **Re-add while draining clobbers the new entry.** The drain closure captures `name`, not the pool, so the old drain deletes the *new* live entry. Leaves routable-but-NOT-resolvable — the inverse of the documented invariant. `/health` 500s **entirely** (unauthenticated; takes the gateway out of LB rotation → restart → per #1 the directory datasources vanish), `/query` 500s, and the orphaned pool leaks past `drainAll()` | `pool-manager.ts:307` |
| 4 | **HIGH** ✅ | **On the `changed` path a ping failure is reported as `withheld` while the old pool keeps serving the OLD policy.** `withheld` is documented as "NOT SERVING". Because change detection is a full deep-compare but the gate is a network `SELECT 1`, a **policy-only tightening** (adding a `DENIED_TABLES` entry, removing `WRITABLE`) silently fails to apply during a transient blip — failure direction is "looser policy stays live" | `pool-manager.ts:256,265` |
| 5 | **CRITICAL (sec)** ✅ | **`liveCaps` refresh fails open on a token-id rename.** Stage 1 authenticates by *secret*; the refresh looks up by *id*, and `if (fresh)` silently skips on miss. Reload reports **applied** while every registered stdio handler keeps the old, wider caps — a **revocation failure**. The code comment "Stage 1 has already guaranteed this resolves" is exactly wrong | `reload.ts:328` |
| 6 | **MEDIUM (sec)** ✅ | **Case bypasses the cross-source collision check.** `DS_<NAME>_*` is case-insensitive (`toUpperCase`) but the check compares verbatim. `DATASOURCES=…,Warehouse` + `warehouse.env` → no refusal and a per-key **hybrid** config: `deniedTables` from `.env`, `host`/`password`/`writable`/`allowUnsafeStatements` from the file. The exact silent credential override the check exists to prevent | `reload.ts:232` |
| 7 | **MEDIUM (sec)** ✅ | **Credential file content echoed into the reload log.** The strict parser embeds the whole offending line; a `PASSWORD "…"` line missing its `=` puts the password in the log — violating "names only, never values", stated three times in that same file | `env-file.ts:92` → `reload.ts:208` |
| 8 | **MED-HIGH** ✅ | **`.env` is parsed by two parsers that disagree** (node `--env-file` at boot vs `parseEnvFile` on reload): inline `#`, backticks, multi-line quoted values, BOM. Causes permanent pool churn on every reload of an unchanged `.env`, and — worst — content inside a node-quoted multi-line string becomes a **real top-level key** on reload, so a `TOKEN_*_SECRET` boot never saw can become live | `env-file.ts:70` |
| 9 | **LOW-MED** ✅ | **`drainAll()` double-`end()`s draining pools** (they are in both collections), so `pg` rejects the second call, the `.catch` swallows it, and shutdown resolves **immediately** instead of waiting — `process.exit(0)` can fire while a client is still running a query. Masked by an idempotent `FakePool.end()` in tests | `pool-manager.ts:327` |
| 10 | **LOW** | **`postureUnverified` is unreachable in production** — `assertReadOnlyPosture` never throws, so neither probe hook can fail. The withhold/`postureUnverified` paths are proven only by throwing test doubles. Compounding: the reload log **drops every `withheld` reason**, so an operator cannot tell "wrong password" from "DB down" | `reload.ts:347`, `pool-manager.ts:74` |
| 11 | **LOW** | **Stale comments invite reinstating the fail-open default.** `config.schema.ts` still argues for the removed per-source `?? true` asymmetry and warns against adding a default — in a repo whose convention is that comments carry the reason a control exists | `config.schema.ts:47` |
| 12 | **LOW** | **`test/gitignore.test.ts` "stays TRACKED" is vacuous** — `isIgnored()` passes `--no-index`, which disregards the index, so no assertion can distinguish tracked from untracked | `gitignore.test.ts:34` |

## Accepted / not defects

- **AC7 (backward compat) NOT MET** — deliberate, user-directed. Blast radius: every existing deployment
  writing to a `.env` datasource gets 403 on writes until it adds `DS_<NAME>_WRITABLE=true`. No restart
  needed (SIGHUP suffices). **No boot-time signal exists** — discovered at first production write.
- **AC3 letter/intent** — the changed path probes posture *after* the swap by Design Decision 11; the
  criterion's "before it is published" predates that resolution. Code is right, criterion text is stale.
- **Verified sound**: `names()` gating for staged datasources (exhaustive enumeration), no caps aliasing
  into the token store, no half-updated capability window, the write gate is not bypassable, the SIGHUP
  coalescing runner has no race, and `services.config`'s single-reader claim still holds.

## Remediation

| # | Status | Fix |
|---|---|---|
| 1 | **FIXED** | New `config/config-sources.ts`. `gatherConfigSources()` is the ONE place every source is read; `resolveConfig()` is what both entrypoints now call. Design Decision 6 is enforced by construction rather than by intent — boot cannot read a different world than reload without deleting a function |
| 2 | **FIXED** | The `DATABASE_*` fallback is materialized into the merge as `DS_MAIN_*` keys via `fallbackAsDsKeys()`, so setting `DATASOURCES` (needed to introduce directory names) no longer suppresses it. Expressed as a key MAP consumed by `buildDatasource`, so the fallback cannot drift from the primary path |
| 3 | **FIXED** | Identity-guarded deletion in `removeDatasource` — the drain callback only deletes if the entry still points at the same pool object |
| 4 | **FIXED** | New `ApplyReport.retainedPrevious` — "SERVING, on the PREVIOUS config". Wired through **six** sites in `reload.ts` including the human-readable summary line, because a failed tightening visible only in a structured field is most of the way back to invisible |
| 5 | **FIXED** | `liveCaps` is refreshed by **secret** (what stage 1 actually validated), not by id, so a token rename can no longer pass stage 1 and then silently skip revocation. Cloned via `capsById` so the store's arrays are never aliased into a process-lifetime object. Fails LOUD if it cannot resolve |
| 6 | **FIXED** | Collision detection is case-insensitive on both sides, matching the case-insensitive `DS_<NAME>_*` namespace. Two `.env` names differing only by case are now refused outright — they are one datasource wearing two labels |
| 9 | **FIXED** | `draining` is a `Map<PgPool, Promise<void>>`; `drain()` is idempotent per pool and `drainAll()` de-duplicates by drain promise, so it JOINS an in-flight drain instead of double-`end()`ing and resolving early |
| 10 | **FIXED** | `withheld` / `postureUnverified` / `retainedPrevious` reasons are logged as per-datasource lines. The security event stays names-only; the reasons sit at the same tier as the existing `pool.on('error')` and posture lines |
| 11, 12 | **FIXED** | Stale comments corrected. `gitignore.test.ts` proves trackability with `git add --dry-run` against a real probe file, and asserts the refusal is specifically *because it is ignored* |
| 7, 8 | in flight | Parser divergence and the log leak |

**Also added — AC7 upgrade safety net.** Boot warns when write-mode tokens exist but **no** datasource
is writable: the exact just-upgraded shape. Deliberately narrow, because a per-datasource version would
fire constantly for the normal case of a `*`-scoped write token across mostly-read-only datasources, and a
warning that always fires is one operators learn to skip.

### Two things this round is worth remembering for

**A fix introduced a regression, and the tests caught it.** Materializing the fallback let stray
`DS_MAIN_*` keys survive into a config the operator expressed purely as `DATABASE_*` — the old code path
read only `DATABASE_*`. Now stripped explicitly before the fallback is applied, with a case pinning it.

**A vacuous test was nearly replaced with another vacuous test.** The first fix for #12 asserted that
`git add --dry-run` fails for a credential file — but that file does not exist, so it failed on "pathspec
did not match" and proved nothing about ignore rules. It now writes a real probe file and asserts the
failure message actually says *ignored*. The lesson generalises: **an assertion that something fails is
only as good as the check that it failed for the intended reason.**

### Deliberately not changed

- **`ok: true` does not flip for a per-datasource failure.** Stage 2 degrades per datasource by design, so
  a reload can be `ok` while individual datasources are `withheld` or `retainedPrevious`. Conflating that
  with a stage-1 refusal would erase the distinction an operator most needs — "nothing moved" vs "most of
  it applied". Documented on the field; automation must read the arrays.
- **`retainedPrevious` is NOT added to the `health.invalidate` loop.** Its pool object never moved, so the
  cached verdict is still valid.
- **`services.config` divergence stays latent.** A `retainedPrevious` datasource leaves `services.config`
  holding the aspirational config while `pools.getConfig()` — what `QueryService` enforces — holds the
  enforced one. Only `assert-readonly-posture.ts` reads `services.config`, and it reads `.tokens`.
  Commented at the assignment so a future reader of `config.datasources` finds the warning first.
- **`drainAll()` now genuinely blocks** on in-flight drains. Correct, but shutdown changes from "exits
  early while a query runs" to "waits for `pool.end()`", making an orchestrator's SIGTERM grace period
  load-bearing. Bounded in practice by `statement_timeout` + `idle_in_transaction_session_timeout`.

---

# Phase 9 — Code Review: findings and remediation

Two further reviews (integration/contract-integrity, and consistency/reuse) ran against the
post-phase-7 code. **One BLOCKING finding**, empirically reproduced.

| # | Sev | Finding | Status |
|---|---|---|---|
| B1 | **BLOCKING** | **Stray `.env` `DS_<NAME>_*` keys silently override a `datasources.d/` datasource, failing OPEN.** The collision check compares directory names against the `DATASOURCES` id *list*, so a leftover key block for a name no longer in that list is invisible to it; `dir.source` then overwrites only the keys the file sets, and every other leftover survives. Verified: `warehouse` came up `writable:true, allowUnsafeStatements:true` on a stale password, from keys the operator believed were inert. Trigger is the migration the README invites | **FIXED** — strip every `DS_<NAME>_*` for each directory name before layering the file's keys, the exact mirror of the `DS_MAIN_*` fallback strip. *This was a failure to generalise a fix already made one function above.* Regression test added |
| B2 | important | `GET /health` could 500 for the **whole endpoint** during a reload that removes a datasource: `check()` awaits a real ping, the datasource is retired during that await, `poolSize()` throws, `Promise.all` rejects. A liveness probe reads 500 as "process dead" and restarts the container | **FIXED** — per-name try/catch returning `{ok:false, poolSize:0}`. Degraded is honest for one entry; 500 for all of them is not |
| B3 | important | The AC7 upgrade safety net fired a **factually false** warning on the reload path: `targets` is the diff there, so a one-element subset claimed "NO datasource is writable" while other writable datasources were live | **FIXED** — boot-only; skipped whenever `only` is set |
| B4 | important | `await reloader.idle()` on shutdown was unbounded. Each changed datasource can cost ~10s (ping + posture), so 3+ exceeds a default 30s k8s grace period and gets SIGKILLed mid-drain — the exact outcome `idle()` was added to prevent | **FIXED** — bounded at 5s; better to drain slightly early than be killed during it |
| B5 | important | Vacuous control in `reload.e2e.test.ts`: a `liveCaps` reload without `mcpToken` took the "not refreshed" branch, so the comment claimed the opposite of what happened and the assertion held against an object nothing had mutated | **FIXED** — the *third* vacuous assertion found in this feature |
| B6 | important | `list()` defined twice. Drift would be security-relevant, not cosmetic: `config-sources` uses the split for the **collision check**, `load-config` re-splits to decide which datasources get **credentials** — different answers means the check guards a different set than the one that gets credentials | **FIXED** — exported from `load-config.ts`, same fix as `capabilityAllows` |
| B7 | important | The token-rename fail-open (the phase-7 C2 fix) was documented at length but **untested** | **FIXED** — 3 tests: the rename narrows live caps, the refresh does not alias the token store, and a refresh skipped for want of the secret is announced |
| B8 | important | `CLAUDE.md`'s Config section still presented `load-config.ts` as the entry point — a contributor would edit the wrong file and miss `.env` parsing, the directory, the fallback, and the collision check | **FIXED** — rewritten around `config-sources.ts`; `parseEnvFile` and `list` added to "shared definitions that must not drift" |
| B9 | important | `retainedPrevious` / `postureUnverified` appear in production logs but nowhere in the README | **FIXED** — a three-outcome table plus the policy-tightening hazard and the meaning of `ok:true` |
| B10 | nice-to-have | `buildDatasource` newly exported with zero importers | **FIXED** — un-exported |
| B11 | nice-to-have | `package.json` script indentation | **FIXED** |

**Rollback safety** — documented in the README rather than fixed in code. Two items are not
plain code reverts: a `datasources.d/` datasource referenced by a token **fails boot** under
the old code, and reverting the `.gitignore` entry **un-ignores live credential files still
on disk**, so a later `git add -A` can commit database passwords. That second one is the
only genuinely dangerous one-way step in this feature.

**Left as accepted follow-ups** (recorded, not fixed): `errMessage` is triplicated (benign
on drift, and folding it next to `redactErrorMessage` would be actively *wrong* — one is raw
server-side extraction, the other is caller-facing redaction, and a shared home invites
reaching for the raw one on a caller path); `ReloadReport` copies `ApplyReport` field-by-field
so a seventh outcome would be dropped with no compiler error; `GatheredSources` returns three
fields nobody reads; three test files each define their own `TestPoolManager`.

## The pattern worth carrying forward

Across phases 7 and 9, **thirteen defects were found in code that had a green suite** — nine of
them reproduced by execution. Three separate vacuous assertions were found, each of which had
made a real defect invisible. The recurring shape is not "we forgot to test it" but **"the test
we wrote could not have failed"**: a double asserting against itself, a `--no-index` flag that
disregards the very index under test, a `git add` on a nonexistent path failing for the wrong
reason, a fixture that never round-tripped so a datasource compared as changed on every reload.

The generalisable rule: **an assertion that something fails is only as good as the check that
it failed for the intended reason** — and a fix applied to one call site should be immediately
generalised to its siblings (B1 was the same bug as one fixed twenty lines above it).
