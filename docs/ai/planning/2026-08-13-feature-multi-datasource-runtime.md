---
phase: planning
title: Project Planning & Task Breakdown
description: Break down work into actionable tasks and estimate timeline
---

# Project Planning & Task Breakdown

Feature: `multi-datasource-runtime`, branch `feature-multi-datasource-runtime`.
Sources: [requirements](../requirements/2026-08-13-feature-multi-datasource-runtime.md) ·
[design](../design/2026-08-13-feature-multi-datasource-runtime.md) ·
[testing](../testing/2026-08-13-feature-multi-datasource-runtime.md).

## Milestones
**What are the major checkpoints?**

- [ ] **M1 — Config sources.** `loadConfig` accepts an injected source; `datasources.d/` is read, permission-checked and normalized; `writable` exists. Nothing reloads yet, and no existing behaviour changes.
- [ ] **M2 — In-place apply + orchestration.** Pools, tokens, health cache and posture probes can all be updated on a live process; `reload.ts` sequences them with the two-stage failure model.
- [ ] **M3 — Transports + discovery.** SIGHUP triggers reload on both entrypoints; the agent can enumerate datasources; the write gate is enforced.
- [ ] **M4 — Verification + docs.** Test plan executed, operator documentation written, typecheck gap closed.

M1 is deliberately behaviour-neutral — it can land and be reviewed without any reload capability existing, which keeps the risky part (M2) small and reviewable on its own.

## Task Breakdown
**What specific work needs to be done?**

### Phase 1: Foundation — M1

**1.1 — `loadConfig(source)` injection** · effort S · deps none
- *Outcome*: `loadConfig(source: Record<string, string|undefined> = process.env)`; every `env()` reads `source`.
- *Validation*: all 14 existing `test/load-config.test.ts` cases pass unchanged; new case proves injection is read instead of `process.env`.
- *Scenarios*: `config/load-config.ts` group.

**1.2 — `writable` field + per-source defaults** · effort S · deps 1.1
- *Outcome*: `writable: z.boolean()` **required** (no zod default) in `datasourceSchema`; `.env` and `DATABASE_*` paths supply `?? true`, the `datasources.d/` path supplies `?? false`.
- *Implementation subtlety the design glossed*: `buildDatasource()` is shared by both paths, so it cannot hard-code one default. Either give it a `writableDefault: boolean` parameter, or have the directory reader **materialize** `DS_<NAME>_WRITABLE=false` when the key is absent so the shared `?? true` never applies. Prefer the explicit parameter — materializing a key that the operator did not write is the kind of implicit rewrite that later reads as a bug.
- *Blast radius (swept, evidence below)*: two typed literal sites — `test/helpers.ts:23` and `test/integration/pg.integration.test.ts:32`. `unsafeConfig` / `deniedConfig` in `test/query-service.test.ts:14,21` spread `config.datasources[0]`, so they inherit it for free.
- *Validation*: schema rejects a config omitting `writable`; the three default paths each proven.
- *Scenarios*: `config.schema.ts` + loaders group.

**1.3 — `config/datasources-dir.ts`** · effort M · deps 1.2
- *Outcome*: reads `*.env` only, enforces mode `600`-or-stricter with an actionable error, derives the name from the filename (`/^[a-z0-9_-]+$/`), normalizes bare keys to `DS_<NAME>_*`, rejects unknown keys, treats a missing directory as a non-error, honours `DATASOURCES_DIR`.
- *Validation*: unit tests with real `fs.chmodSync` fixtures in temp dirs; root-skip guard for the one real-file permission test.
- *Scenarios*: `config/datasources-dir.ts` group (10 cases).

**1.4 — `.gitignore` + in-directory template** · effort XS · deps 1.3
- *Outcome*: `datasources.d/` ignored, `!datasources.d/example.env.disabled` negated and tracked; the template documents the bare-key shape in place.
- *Validation*: `git check-ignore datasources.d/warehouse.env` exits **0** (today it exits 1 — verified), while the template stays tracked.
- *Scenarios*: gitignore case.

### Phase 2: Core Features — M2

**2.1 — `PoolManager.applyDatasources()`** · effort M · deps 1.2
- *Outcome*: diff by name; add / replace-and-drain / remove. Removal drops from `names()` immediately but keeps the entry resolvable in a **draining map** until `pool.end()` resolves. Pool construction throwing is caught per datasource and reported withheld. Every new pool gets the mandatory `pool.on('error')`.
- *Validation*: add/replace/remove unit cases; the removal-race case asserting no 500 for a request that already passed `datasourceReady()`.
- *Scenarios*: `pool-manager.ts` group + removal-race case.

**2.2 — `HealthChecker.invalidate(name)`** · effort XS · deps none
- *Outcome*: drops the cached verdict so the next `check()` re-pings.
- *Validation*: changed datasource does not serve a pre-swap verdict; unaffected datasource keeps its cache entry.
- *Scenarios*: `health-checker.ts` group.

**2.3 — `TokenAuth.applyTokens()` + `capsById()`** · effort S · deps none
- *Outcome*: digest array rebuilt in place; `capsById` resolves a token id to capabilities.
- *Validation*: new token authenticates, removed token stops; constant-time scan-all behaviour preserved.
- *Scenarios*: `token-auth.ts` group.

**2.4 — `assertReadOnlyPosture` subset + warm-up control** · effort S · deps none
- *Outcome*: optional `{ only?: string[]; warmParser?: boolean }`; boot behaviour unchanged when omitted.
- *Validation*: probe call count proves only affected datasources are probed; warm-up skipped on reload, still runs at boot.
- *Scenarios*: subset/warm-up cases.

**2.5 — `config/reload.ts` orchestrator** · effort L · deps 1.3, 2.1–2.4
- *Outcome*: stage 1 all-or-nothing validation (permissions · parse · zod · name collision across sources · MCP identity still authenticates against the candidate set); stage 2 per-datasource degrade (ping → posture → publish, withhold on failure); boot-only key comparison across **both** baselines; `services.config = next`; `ReloadReport`; security-event log with names only.
- *Validation*: every stage-1 refusal leaves `pools.names()` and token digests byte-identical; sibling datasource still publishes when one fails; log carries no credential values.
- *Scenarios*: both `reload.ts` groups (13 cases) — the largest single block in the test plan.

**2.6 — Datasource-level write gate** · effort S · deps 1.2
- *Outcome*: `if (input.write && !dsCfg.writable) → ForbiddenError`, audited, at `QueryService.run()` after the single-statement scan and before DB contact. Constructor unchanged.
- *Validation*: 403 before DB contact even for a write token with `readOnly:false`; rejection audited; reads unaffected.
- *Scenarios*: `query-service.ts` write-gate group.

### Phase 3: Integration & Polish — M3

**3.1 — SIGHUP wiring + live caps refresh** · effort S · deps 2.5, 2.3
- *Outcome*: `process.on('SIGHUP', …)` on `server.ts` and `mcp-server.ts`, serialized so overlapping signals cannot interleave two reloads. stdio refreshes the live caps via `Object.assign(liveCaps, capsById(id))`.
- *Validation*: an already-registered tool handler sees new grants; no handler observes a half-updated capability set.
- *Scenarios*: MCP identity refresh group.

**3.2 — Discovery: `list_datasources` + `/datasources` parity** · effort S · deps 1.2
- *Outcome*: new MCP tool returning `{name, defaultSchema, writable}`, caps-filtered; `datasources.route.ts:16` gains `writable`; `buildInstructions` stops enumerating names and points at the tool.
- *Validation*: caps filtering proven; the HTTP and MCP shapes asserted **equal** so they cannot drift.
- *Scenarios*: `mcp/tools.ts` group.

**3.3 — Operator documentation** · effort M · deps 3.1, 3.2
- *Outcome*: `README.md` gains a reload section (directory shape, `WRITABLE`, SIGHUP commands per transport, boot-only keys, Windows limitation); `.env.example` cross-references the directory; `CLAUDE.md` reconciles the now-coexisting `plans/` and `docs/ai/` conventions.
- *Validation*: an operator can follow the README to add a datasource without reading source.

### Phase 4: Verification — M4

**4.1** Unit tests per the testing doc (all groups above) · effort L · deps their features
**4.2** Integration tests against real Postgres (5 cases) · effort M · deps 2.5
**4.3** E2E through `app.inject` + MCP handlers (6 cases) · effort M · deps 3.1, 3.2
**4.4** **Close the typecheck gap** · effort S · deps 1.2 — see Risks R2. Fix the one pre-existing error and add a `typecheck:test` script (or widen `tsconfig`), so test-file type errors stop being invisible.

## Dependencies
**What needs to happen in what order?**

```
1.1 ──► 1.2 ──┬──► 1.3 ──► 1.4
              ├──► 2.1 ──┐
              ├──► 2.6   │
              └──► 3.2   ├──► 2.5 ──► 3.1 ──► 3.3
        2.2 ──────────────┤
        2.3 ──────────────┤              └──► 4.3
        2.4 ──────────────┘
                       └──► 4.2
```

- **1.1 gates everything** — the injected source is the seam the whole feature hangs on.
- **2.2, 2.3, 2.4 are independent** of the config work and can proceed in parallel with 1.3.
- **2.5 is the integration point**; it should be attempted only once 2.1–2.4 exist, or it will be written against imagined interfaces.
- **No external dependencies.** No new npm packages (design decision: `node:fs` + `statSync().mode` suffice).
- **Operator-action dependencies** (never automated): creating read-only DB roles per `docs/runbooks/agent-ro-pg-role.md`, and setting `600` on real datasource files.

## Timeline & Estimates
**When will things be done?**

No calendar dates — none were given, and inventing them would be noise. Relative effort only:

| Milestone | Tasks | Aggregate effort |
|---|---|---|
| M1 | 1.1–1.4 | S + S + M + XS |
| M2 | 2.1–2.6 | M + XS + S + S + **L** + S |
| M3 | 3.1–3.3 | S + S + M |
| M4 | 4.1–4.4 | L + M + M + S |

Buffer belongs on **2.5** (the orchestrator) and **4.2** (integration tests need a reachable second cluster, which may not exist locally — those cases will skip until one is configured, exactly as the existing 15 do).

## Risks & Mitigation
**What could go wrong?**

| # | Risk | Mitigation |
|---|---|---|
| R1 | Making `writable` required breaks `DatasourceConfig` literal sites | Swept with evidence: exactly **two** sites (`test/helpers.ts:23`, `test/integration/pg.integration.test.ts:32`). Spread-based configs inherit it |
| R2 | **Test type errors are invisible.** `tsconfig.json` excludes `test/` and `tsx` strips types without checking. Verified by widening the config: **1 pre-existing error** — `pg.integration.test.ts:32` already misses `deniedTables` + `sensitiveRelationDenylist` and works only by accident (`allowUnsafeStatements:true` skips the code that would read them) | Task 4.4. The suite is otherwise type-clean, so the fix is one site plus a script — cheap now, and it stops this feature adding more invisible errors |
| R3 | Removal race surfaces a spurious **500** — `getPool`/`getConfig` throw plain `Error` → `statusOf` → 500, reachable after `datasourceReady()` passed | Draining map in 2.1 keeps the entry resolvable through the drain window |
| R4 | Shared `buildDatasource()` cannot carry both `writable` defaults | Explicit `writableDefault` parameter (1.2), not an implicit key rewrite |
| R5 | A reload mid-query fails or delays in-flight work | `pool.end()` waits for checked-out clients; explicit test in 4.2 |
| R6 | Permission tests behave differently when CI runs as root | Assert on the checking function given a stat mode; the one real-file test skips when `getuid() === 0` |
| R7 | SIGHUP undeliverable on Windows | Documented limitation (3.3); restart workflow retained |
| R8 | Reload cost scales with total datasource count if the subset filter is forgotten | 2.4 plus a probe-call-count assertion, so a regression fails a test rather than just being slow |
| R9 | Overlapping SIGHUPs interleave two reloads | Serialize in 3.1 — a reload in flight defers or drops the next signal |

## Resources Needed
**What do we need to succeed?**

- **People**: single implementer; no coordination dependencies. Privilege changes stay operator actions.
- **Tools**: existing toolchain only — `tsx`, `node:test`, `tsc`. No new dependencies.
- **Infrastructure**: a **second reachable Postgres cluster** for the 4.2 integration cases to actually run rather than skip. `docker compose` provides one; a second container or a second database on it would cover the cross-cluster path.
- **Knowledge**: `docs/runbooks/agent-ro-pg-role.md` for read-only roles; `.claude/agent-memory/code-reviewer/` for the three prior guard bypasses; three ai-devkit memory items now recorded for this feature (posture invariant, reload seams, gitignore coverage).

## Test-plan coverage check
**Does every test scenario have an owning task?**

| Testing doc group | Owning task |
|---|---|
| `config/datasources-dir.ts` (10) | 1.3 |
| `config/load-config.ts` (3) | 1.1 |
| `config.schema.ts` + loaders (6) | 1.2 |
| `reload.ts` stage 1 (7) | 2.5 |
| `reload.ts` stage 2 (13) | 2.5, with 2.4 owning the probe-count cases |
| `pool-manager.ts` (5) + removal race | 2.1 |
| `health-checker.ts` (3) | 2.2 |
| `token-auth.ts` (3) | 2.3 |
| MCP identity refresh (3) | 3.1 |
| `query-service.ts` write gate (5) | 2.6 |
| `mcp/tools.ts` (4) | 3.2 |
| gitignore case | 1.4 |
| Integration (5) | 4.2 |
| E2E (6) | 4.3 |

Every group is owned. One contradiction was found and **fixed during this phase** rather than deferred:
the testing doc carried a `maxRowsCeiling` case asserting the clamp follows a reload via `ConfigStore`,
which design decision 9 had already invalidated. It now asserts the opposite — that the constructor is
unchanged and the clamp is boot-only — with the warn path covered by the `reload.ts` boot-only cases.
