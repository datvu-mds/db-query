# Phase 05 — Docs, `.env` sync, user-action callouts

## Context Links
- Plan: [plan.md](plan.md) · may start after [phase-03](phase-03-query-service-wiring-and-internal-path.md)
- Design: [brainstorm](../reports/brainstorm-260803-run-query-relation-guard-hardening.md) §4 (deny list), "Residual risks", "⚠️ Immediate user actions"
- Docs to sync: `README.md`, `.env.example`, `docs/risks/2026-07-29-mcp-run_query-write-and-rce-bypass.md`, `docs/runbooks/agent-ro-pg-role.md`, `docs/journals/2026-07-30-statement-guard-quoted-identifier-bypass.md`, `../../docs/design-notes/pg-connection-pool-query-gateway.md`, root `../../CLAUDE.md`
- Rule: `.claude/rules/no-migrations-rule.md` — the agent writes SQL **into docs**, never runs it

## Overview
- **Priority:** P1 — the guard changes the documented trust model; leaving the old text in place actively misinforms.
- **Status:** ⬜ Pending.
- **Description:** Document the relation guard, ship the MDS deny list in `.env.example`, rewrite the "schema caps are NOT a hard tenant boundary" section (it is now a real boundary for relations), record residual risks, and state the two user-only actions.

## Key Insights
- README §"⚠️ Trust boundary — schema caps are NOT a hard tenant boundary" is now **wrong** as written: qualified cross-schema refs are checked against caps. It must be rewritten, not appended to — a stale warning of the "you are not protected" kind is the most dangerous doc drift there is.
- The `U&"…"` unicode-escape residual gap called out in `statement-guard.ts`'s header, the README, and `docs/journals/2026-07-30-…` is **closed** by the parser path. Update all three; keep the lexer scan documented as belt-and-braces.
- `.env` is gitignored and privacy-blocked → the agent edits `.env.example` only; the live `.env` line is a **user action** with the exact string to paste.
- Context-doc impact: **none** — this repo has no `*_AI_CONTEXT.md` / `*_ARCHITECTURE.md` (verified by `find`); README + the workspace design note are authoritative (same finding as the 20260730 plan).

## Requirements
- README gains a **Relation guard** subsection under §"Security notes", next to the statement guard, covering: the parser, the four relation rules, the denied-table config, the internal introspection path, the escape hatch, and the residual risks.
- README statement-guard section: `SHOW` removed from the allowlist (and why); unicode-escape gap now closed by the parser.
- README config table/section documents `DS_<NAME>_DENIED_TABLES`.
- `.env.example`: commented `DS_MAIN_DENIED_TABLES` with the agreed MDS list.
- Risk report: add a status line — schema-boundary + metadata + denylist gaps closed at the app layer; DB-grants remain the durable fix.
- Runbook `agent-ro-pg-role.md`: cross-reference that the app-layer denylist is the belt and explicit grants are the braces (the deferred approach C).
- Journal `2026-07-30-statement-guard-quoted-identifier-bypass.md`: append "closed by the parser guard (2026-08-03)".
- Design note `../../docs/design-notes/pg-connection-pool-query-gateway.md`: add the relation guard to the structure/tradeoffs sections (approaches B/C/D and why they lost).
- Root `../../CLAUDE.md` §"Database Reads (pg-connection-pool MCP)": one line that `run_query` blocks catalog/`information_schema` and some sensitive tables, and that structure comes from the introspection tools.
- Brainstorm report: mark **implemented** with a link back to this plan.

## Architecture
`.env.example`, appended to the `DS_MAIN_*` block:

```dotenv
# Relation denylist enforced by the relation guard: any query whose parse tree
# references one of these relations is rejected (400) before DB contact. Entries are
# `table` (matches in ANY schema) or `schema.table` (exact); case-insensitive.
# Default is EMPTY — the gateway is generic, deployments declare their own list.
# The list below is the MDS identity/secrets set (verified against the live DB
# 2026-08-03). Skipped when DS_MAIN_ALLOW_UNSAFE_STATEMENTS=true.
DS_MAIN_DENIED_TABLES=user,user_login_session,user_settings,account_user,role,role_subscriptions,stage_roles,stage_role_access_controls,stage_access_controls,workspace_access_controls,data_register_access_controls,system_settings,env_dump,pg_rce_out
```

README §"Relation guard (schema boundary + metadata block + denylist)" — content skeleton:
- **Why:** read-only says *whether* you can write, nothing about *what* you can read. Caps gated only the declared schema; `pg_catalog` cannot be revoked in Postgres; grants are additive so tables cannot be carved out of `pg_read_all_data`.
- **How:** every statement is parsed with the real Postgres parser (`libpg-query`); the guard walks the tree for relations (CTE-aware) and function names. Unparseable SQL is rejected — fail-closed.
- **Rules:** qualified system schema → 400 · qualified other schema outside token caps → 403 · unqualified `pg_%` → 400 · effective schema + relname on `DS_<NAME>_DENIED_TABLES` → 400.
- **Metadata:** `list_schemas`/`list_tables`/`describe_table` are the sanctioned, caps-filtered path and run on an internal trusted route that cannot be requested by a caller.
- **Escape hatch:** `DS_<NAME>_ALLOW_UNSAFE_STATEMENTS=true` skips statement **and** relation guard; boot WARNs.
- **Residual risks:** a view in an allowed schema over a denied table still leaks it (no such views known); scalar metadata functions (`version()`, `current_setting()`, `current_user`) still readable; the DB role is still `pg_read_all_data` — explicit grants (runbook) remain the durable fix.

README §"⚠️ Trust boundary" rewrite (replace the "SCHEMAS is an accident-guard, not a boundary" claim):
> Since the relation guard, a token's `SCHEMAS` capability **is** enforced against the relations a query actually references, not just the declared `schema` — a token scoped to `public` gets a 403 on `SELECT * FROM "other_tenant".t`. This is app-layer enforcement over a shared DB role: it holds as long as the guard does, and a view in an allowed schema can still read across. For a hard boundary, enforce it in Postgres (role per token, or explicit grants per `docs/runbooks/agent-ro-pg-role.md`).

## Related Code Files
- **Modify:** `README.md`, `.env.example`, `docs/risks/2026-07-29-mcp-run_query-write-and-rce-bypass.md`, `docs/runbooks/agent-ro-pg-role.md`, `docs/journals/2026-07-30-statement-guard-quoted-identifier-bypass.md`, `../../docs/design-notes/pg-connection-pool-query-gateway.md`, `../../CLAUDE.md`, `../reports/brainstorm-260803-run-query-relation-guard-hardening.md`
- **Create:** none (no `*_AI_CONTEXT.md` exists — state `Context-doc impact: none`)
- **Do NOT touch:** `.env` (gitignored, privacy-blocked — user action below)

## ⚠️ USER-ONLY actions (document, never execute)
The agent must not run DDL, migrations, or secret rotation (`.claude/rules/no-migrations-rule.md`). Surface these in the completion note **and** in the risk report:

1. **Add the deny list to the live `.env`** — paste the `DS_MAIN_DENIED_TABLES=…` line from `.env.example` and restart the gateway / reconnect MCP. Until this is done the code default is empty and **no table is denied**.
2. **Drop the RCE-PoC leftovers** — `DROP TABLE IF EXISTS public.env_dump; DROP TABLE IF EXISTS public.pg_rce_out;` (leftovers from the 2026-07-29 PoC; `env_dump` likely holds dumped environment secrets). USER-run SQL only. They are on the deny list meanwhile, which hides them from `run_query` but does not remove them.
3. **Rotate secrets** that were in the gateway/DB host environment at PoC time (DB password, bearer token + `MCP_TOKEN`, any app secret in that env).

## Implementation Steps
1. `.env.example`: add the block above.
2. README: new relation-guard subsection; update the statement-guard subsection (`SHOW` gone, unicode gap closed); update the config section with `DS_<NAME>_DENIED_TABLES`; rewrite the trust-boundary section.
3. Risk report: status line + the three user actions.
4. Runbook + journal cross-references.
5. Design note: relation guard in Structure/Tradeoffs (record rejected approaches B regex-extension, C DB grants — deferred, D LLM validator — rejected: tool ordering is unenforceable in MCP, prompt-injectable via SQL comments, latency/outage coupling).
6. Root `CLAUDE.md`: one-line MCP usage note.
7. Mark the brainstorm report implemented; add a completion note to `plan.md` (files touched, test counts, carry-overs).
8. Verify every relative link resolves (`README` → `docs/…`, plan → `../reports/…`).

## Todo List
- [ ] `.env.example` deny-list block
- [ ] README: relation-guard subsection
- [ ] README: statement-guard subsection updated (`SHOW`, unicode gap closed)
- [ ] README: config section + trust-boundary section rewritten
- [ ] Risk report status + user actions
- [ ] Runbook + journal cross-references
- [ ] Design note updated (incl. rejected approaches)
- [ ] Root `CLAUDE.md` MCP note
- [ ] Brainstorm marked implemented; `plan.md` completion note
- [ ] `Context-doc impact: none` stated explicitly
- [ ] User-only actions listed in the completion message

## Success Criteria
- No document still claims schema caps are advisory-only or that the unicode-escape bypass is open.
- A new operator can enable the deny list from `.env.example` alone, and knows the code default is empty.
- The three user-only actions appear in the risk report **and** the final completion message, marked USER-run.
- All relative links resolve; no doc references a file that does not exist.

## Risk Assessment
| Risk | L×I | Mitigation |
|---|---|---|
| Deploy ships code but nobody adds `DS_MAIN_DENIED_TABLES` → false sense of protection | **High** × High | Boot log prints the denied-table **count**; `.env.example` carries the list; user action #1 is called out in the completion message |
| Doc says "blocked" where code says "allowed" (drift) | Med × High | Write the README section from the shipped `relation-guard.ts` rules, not from this plan's prose; re-read the code first |
| Agent edits `.env` and trips the privacy hook / leaks secrets into a diff | Low × High | `.env` is explicitly out of scope; user action only |
| Someone reads the deny list as a tenant-isolation guarantee | Med × Med | Residual-risk paragraph (views, shared role) is mandatory in the README section |

## Security Considerations
- Never paste real secrets or live table data into docs; the deny list is table **names** only.
- Keep the "defense-in-depth, not the guarantee" framing — the DB role is still `pg_read_all_data`.
- `env_dump` / `pg_rce_out` are denied by the guard but still exist and are still readable by anything else holding that role; the doc must not imply the denylist remediates them.

## Next Steps
- Optional follow-ups (not this plan): explicit-grants runbook to drop `pg_read_all_data`; advisory async audit flag if the audit stream ever shows a semantic gap the parser cannot see.
