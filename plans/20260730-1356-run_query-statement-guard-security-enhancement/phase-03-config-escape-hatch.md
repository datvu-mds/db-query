# Phase 03 — `.env` escape hatch (`allowUnsafeStatements`)

## Context Links
- Plan: [plan.md](plan.md) · depends on [phase-02](phase-02-statement-guard.md)
- Config: `src/config/config.schema.ts`, `src/config/load-config.ts`
- Boot visibility: `src/boot/assert-readonly-posture.ts`

## Overview
- **Priority:** P1 (user-requested).
- **Status:** ✅ Done.
- **Description:** A per-datasource, default-**false**, fail-closed opt-in that relaxes the Phase-02 statement guard for operators who deliberately run a privileged/superuser datasource and need `COPY`/file/admin statements. Only this new guard is relaxed — `assertSingleStatement`, the read-only txn, and `DISCARD ALL` are untouched.

## Key Insights
- Per-datasource is the correct granularity: the risk is tied to the DB role behind a datasource, and the config already uses `DS_<NAME>_*` keys. Mirrors `ssl` exactly (`bool(env(...))` + `z.boolean().default(false)`).
- Fail-closed: absence/empty/malformed ⇒ `false` ⇒ guard enforced. `bool()` in `load-config.ts` already returns `undefined` for missing and only `true` for the literal string `"true"`; zod `.default(false)` finishes the job.
- Must be **loud**: enabling it removes a security layer, so boot logs a WARN naming the datasource — consistent with the codebase's "make misconfig loud" philosophy (`assert-readonly-posture.ts`).

## Requirements
- New optional datasource config: `allowUnsafeStatements: boolean` (default `false`).
- Env key: `DS_<NAME>_ALLOW_UNSAFE_STATEMENTS=true` (and the fallback `DATABASE_ALLOW_UNSAFE_STATEMENTS` for the seeded `main` datasource).
- Phase-02 wiring reads `dsCfg.allowUnsafeStatements`.
- Boot emits a WARN per datasource where it is `true`.

## Architecture
1. `config.schema.ts` — add to `datasourceSchema`:
   ```ts
   // Escape hatch: when true, the per-statement guard (statement-guard.ts) is skipped
   // for this datasource — dangerous/admin statements (COPY, pg_read_file, …) are
   // permitted. Default false = guard enforced. Multi-statement + read-only txn stay on.
   allowUnsafeStatements: z.boolean().default(false),
   ```
2. `load-config.ts` — in `buildDatasource`: `allowUnsafeStatements: bool(env(\`${p}ALLOW_UNSAFE_STATEMENTS\`))`; in `fallbackDatasource`: `allowUnsafeStatements: bool(env('DATABASE_ALLOW_UNSAFE_STATEMENTS'))`.
3. Boot warning — extend `assert-readonly-posture.ts` (it already iterates every datasource) to add, per datasource with the flag on:
   ```
   statement guard DISABLED (DS_<NAME>_ALLOW_UNSAFE_STATEMENTS=true) — dangerous
   statements are permitted for this datasource; ensure the DB role is trusted.
   ```
   Alternatively a tiny dedicated boot logger if we prefer not to widen the posture module — decide during impl (prefer reusing the existing per-datasource loop to avoid a second boot pass).
4. `.env.example` — document the new key with a security caveat.

## Related Code Files
- **Modify:** `src/config/config.schema.ts`, `src/config/load-config.ts`, `src/boot/assert-readonly-posture.ts`, `.env.example`
- **Read for context:** `src/query/query-service.ts` (consumer from Phase 02)

## Implementation Steps
1. Add the schema field (default false).
2. Load it in both `buildDatasource` and `fallbackDatasource`.
3. Emit a boot WARN when true.
4. Document in `.env.example`.
5. `npm run typecheck`.

## Todo List
- [x] `allowUnsafeStatements` in `datasourceSchema` (default false)
- [x] Load `DS_<NAME>_ALLOW_UNSAFE_STATEMENTS` + `DATABASE_` fallback
- [x] Boot WARN when enabled
- [x] `.env.example` documented with caveat
- [x] typecheck green

## Success Criteria
- Unset/`false`: guard enforced (Phase-02 rejections apply).
- `true`: guarded statements execute; boot logs the WARN naming the datasource.
- `DS_MDS_MAIN_ALLOW_UNSAFE_STATEMENTS=garbage` ⇒ treated as `false` (fail-closed).

## Risk Assessment
- **Flag becomes a silent always-on** in some env → mitigated by the loud boot WARN + fail-closed default + `.env.example` caveat.
- **Widening `assert-readonly-posture.ts`** blurs its single responsibility → keep the addition to one clearly-commented block, or split into a `warn-unsafe-statements.ts` if it grows.

## Security Considerations
- The escape hatch is the *only* sanctioned way to run unsafe statements; it never disables multi-statement protection or the read-only transaction.
- Enabling it re-exposes C-1…C-4/M-1/M-2 **iff** the DB role is privileged — hence the WARN cross-references the posture check. The durable fix remains Phase 05 (non-superuser role); the flag is an operator's informed override.

## Next Steps
- Phase 04 tests both states (enforced vs relaxed) through `QueryService`.
