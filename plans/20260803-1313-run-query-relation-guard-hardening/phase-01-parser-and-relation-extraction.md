# Phase 01 — Parser dependency + relation/function extraction

## Context Links
- Plan: [plan.md](plan.md) · Design: [brainstorm](../reports/brainstorm-260803-run-query-relation-guard-hardening.md) §1
- Existing lexer kept as belt-and-braces: `src/query/sql-lexer.ts`
- Existing consumer to refactor (DRY): `src/query/statement-guard.ts` (banned-function list)
- Prior-art phase style: [20260730 phase-01](../20260730-1356-run_query-statement-guard-security-enhancement/phase-01-shared-sql-lexer.md)

## Overview
- **Priority:** P0 — everything else consumes this.
- **Status:** ⬜ Pending.
- **Description:** Add `libpg-query` (real Postgres parser, WASM). New module `src/query/relation-guard.ts` exposing **extraction only**: parse one statement, return every referenced relation (CTE-aware) plus every called function name (decoded). No policy yet.

## Key Insights
- The parser gives **decoded identifiers**: `U&"\0070g_read_file"` arrives as `pg_read_file`, and unquoted names arrive already case-folded to lower case. That is the whole reason for the dependency — a lexer cannot decode unicode escapes (documented residual gap in `statement-guard.ts` header).
- Only `RangeVar` nodes are relation references. Do **not** pattern-match the word `pg_catalog` in the tree: every `::int` cast carries `TypeName.names = ['pg_catalog','int4']` and would false-positive.
- CTE scoping must follow real PG rules or it becomes a bypass: a non-recursive CTE body sees only **preceding** CTE names. Flat "collect all WITH names" would let `WITH a AS (SELECT * FROM "user"), "user" AS (SELECT 1) SELECT * FROM a` hide the real `user` table behind a later CTE name.
- `EXPLAIN` needs no special case — `ExplainStmt.query` is walked by the generic recursion.
- Pathological nesting is bounded by the parser itself (`stack depth limit exceeded` → parse error → reject in Phase 02).

## Requirements
- Dep: `libpg-query@pg18` (18.1.4). WASM-only, no native build, dual ESM/CJS (`wasm/index.js` ESM entry) — matches this repo's `"type": "module"` + `NodeNext`.
  - Install: `npm install libpg-query@pg18` (run by whoever executes the phase; commit `package.json` + `package-lock.json`).
  - Rationale for pg18 over the `latest`/pg17 tag: `docker-compose.yml` runs `postgres:18-alpine` and a **newer** parser minimises false rejections (an older parser rejecting newer server syntax = fail-closed 400 on legit SQL).
- API used: `import { parse } from 'libpg-query'` — async, self-initialising. Do **not** use `parseSync` (needs a prior async init; `run()` is already async).
- `extractSqlRefs(sql)` returns `{ relations, functions }`; throws the raw parser error (Phase 02 converts to 400).
- Relations: `{ schema?: string; relation: string }`, schema `undefined` when unqualified.
- Functions: last element of `FuncCall.funcname` (qualifier ignored — `pg_catalog.pg_read_file` and `pg_read_file` are the same function).
- CTE names introduced by an enclosing `WITH` are **not** relations (per-level, order-aware, `RECURSIVE`-aware).
- Shared banned-function names extracted to one module so lexer scan and parser scan cannot drift.

## Architecture

New `src/query/banned-functions.ts` (moved out of `statement-guard.ts`, single source of truth):

```ts
/** Whole-identifier name fragments (regex source, case-insensitive). */
export const BANNED_FUNCTION_SOURCES = [
    'pg_read_file', 'pg_read_binary_file', 'pg_stat_file', 'pg_ls_\\w+',
    'lo_export', 'lo_import', 'dblink\\w*',
    'pg_reload_conf', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_rotate_logfile',
    'pg_logical_emit_message', 'pg_create_logical_replication_slot', 'pg_create_physical_replication_slot',
    'pg_drop_replication_slot', 'pg_replication_slot_advance',
    'pg_logical_slot_get_changes', 'pg_logical_slot_peek_changes',
    'pg_stat_reset\\w*',
] as const;

/** Text-scan shape used by statement-guard: `<name>` + optional space + `(`. */
export const BANNED_CALL_PATTERNS: RegExp[] = BANNED_FUNCTION_SOURCES.map((s) => new RegExp(`\\b(${s})\\s*\\(`, 'i'));

/** Name-only match used by the parser scan (identifier already decoded). */
export function bannedFunctionName(name: string): string | null {
    return BANNED_FUNCTION_SOURCES.some((s) => new RegExp(`^${s}$`, 'i').test(name)) ? name : null;
}
```

New `src/query/relation-guard.ts` (extraction half; policy lands in Phase 02):

```ts
import { parse } from 'libpg-query';

export interface RelationRef { schema?: string; relation: string }
export interface SqlRefs { relations: RelationRef[]; functions: string[] }

export async function extractSqlRefs(sql: string): Promise<SqlRefs> {
    const tree = await parse(sql);                    // { version, stmts: [{ stmt }] }
    const out: SqlRefs = { relations: [], functions: [] };
    walk(tree.stmts, new Set<string>(), out);         // single statement guaranteed upstream
    return out;
}

type Node = Record<string, unknown>;

function walk(node: unknown, scope: ReadonlySet<string>, out: SqlRefs): void {
    if (Array.isArray(node)) { for (const n of node) walk(n, scope, out); return; }
    if (!node || typeof node !== 'object') return;
    const obj = node as Node;

    // A node carrying WITH opens a CTE scope for its whole subtree.
    let childScope = scope;
    const withClause = obj.withClause as Node | undefined;
    if (withClause && Array.isArray(withClause.ctes)) childScope = walkWith(withClause, scope, out);

    for (const [key, value] of Object.entries(obj)) {
        if (key === 'withClause') continue;                 // consumed above
        if (key === 'RangeVar') { collectRelation(value as Node, childScope, out); continue; }
        if (key === 'FuncCall') collectFunction(value as Node, out);   // fall through: walk args too
        walk(value, childScope, out);
    }
}

/** PG scoping: cte[i]'s body sees cte[0..i-1] (plus itself when RECURSIVE);
 *  the main query body sees all of them. Adding each name AFTER walking its own
 *  body is what stops a later CTE name from masking a real table earlier on. */
function walkWith(withClause: Node, scope: ReadonlySet<string>, out: SqlRefs): ReadonlySet<string> {
    const recursive = withClause.recursive === true;
    const names = new Set(scope);
    for (const node of withClause.ctes as unknown[]) {
        const cte = (node as Node).CommonTableExpr as Node | undefined;
        if (!cte) { walk(node, names, out); continue; }
        const name = typeof cte.ctename === 'string' ? cte.ctename : '';
        walk(cte.ctequery, recursive && name ? new Set([...names, name]) : names, out);
        if (name) names.add(name);
    }
    return names;
}

function collectRelation(rv: Node, scope: ReadonlySet<string>, out: SqlRefs): void {
    const relation = typeof rv.relname === 'string' ? rv.relname : '';
    if (!relation) return;
    const schema = typeof rv.schemaname === 'string' && rv.schemaname !== '' ? rv.schemaname : undefined;
    if (!schema && scope.has(relation)) return;    // CTE reference, not a table
    out.relations.push({ schema, relation });
}

/** funcname: [{String:{sval:'pg_catalog'}},{String:{sval:'pg_read_file'}}] → last part. */
function collectFunction(fc: Node, out: SqlRefs): void {
    const parts = Array.isArray(fc.funcname) ? fc.funcname : [];
    const last = parts[parts.length - 1] as Node | undefined;
    const sval = (last?.String as Node | undefined)?.sval;
    if (typeof sval === 'string' && sval !== '') out.functions.push(sval);
}
```

`statement-guard.ts` refactor: delete the local `BANNED_FUNCTIONS` array, `import { BANNED_CALL_PATTERNS }` and iterate it. **Behaviour unchanged** — `statement-guard.test.ts` must stay green with zero edits in this phase.

## Related Code Files
- **Create:** `src/query/relation-guard.ts`, `src/query/banned-functions.ts`
- **Modify:** `src/query/statement-guard.ts` (import shared list only), `package.json` + `package-lock.json`
- **Read for context:** `src/query/sql-lexer.ts`, `src/query/query-service.ts`

## Implementation Steps
1. `npm install libpg-query@pg18`; confirm `package.json` records `"libpg-query": "^18.1.4"` (dependencies, not dev).
2. Smoke-verify the dep under this repo's ESM/tsx setup **and prove it is stdio-silent** (the MCP stdio transport dies if anything prints to fd 1):
   `node --input-type=module -e "const m=await import('libpg-query');console.error(JSON.stringify((await m.parse('select 1 from t')).stmts));" 1>/dev/null`
   → nothing on stdout, parse tree on stderr.
3. Create `banned-functions.ts` with the list above; refactor `statement-guard.ts` to consume it; run `npm test -- test/statement-guard.test.ts` (unchanged, green).
4. Create `relation-guard.ts` with `extractSqlRefs` + walker exactly as specified.
5. Manual tree sanity-check (temporary scratch script, not committed) on: `WITH x AS (SELECT 1) SELECT * FROM x JOIN public."user" u ON true`, `EXPLAIN SELECT * FROM information_schema.tables`, `SELECT U&"\0070g_read_file"('/etc/passwd')` — confirm relations/functions come out decoded and the CTE is absent from `relations`.
6. `npm run typecheck` clean. If `@pgsql/types` conflicts with `skipLibCheck`/NodeNext, keep the permissive `Record<string, unknown>` walk (do **not** adopt generated node types — they churn per PG major).

## Todo List
- [ ] `libpg-query@pg18` installed, lockfile committed
- [ ] Stdout-silence + ESM import verified
- [ ] `banned-functions.ts` created; `statement-guard.ts` consumes it; its tests green untouched
- [ ] `relation-guard.ts` `extractSqlRefs` + CTE-aware walker
- [ ] Manual tree sanity-check on the three probe statements
- [ ] `npm run typecheck` green

## Success Criteria
- `extractSqlRefs('SELECT * FROM a JOIN s.b ON true')` → relations `[{relation:'a'},{schema:'s',relation:'b'}]`.
- `WITH t AS (SELECT 1) SELECT * FROM t` → **no** relations.
- `WITH a AS (SELECT * FROM "user"), "user" AS (SELECT 1) SELECT * FROM a` → relations include `{relation:'user'}` (later CTE name must NOT mask it).
- `EXPLAIN SELECT * FROM information_schema.tables` → `{schema:'information_schema',relation:'tables'}`.
- `SELECT U&"\0070g_read_file"('/x')` → functions include `pg_read_file`.
- `VALUES (1)` → empty relations, no throw. Invalid SQL → throws.
- `statement-guard.test.ts` passes unchanged; `npm run typecheck` clean.

## Risk Assessment
| Risk | L×I | Mitigation |
|---|---|---|
| WASM module prints to stdout → corrupts MCP stdio JSON-RPC | Low × **High** | Step 2 asserts silence before anything else; if it prints, wrap the import and redirect at load, or fall back to the HTTP MCP transport |
| Parse-tree key names differ across PG majors (`String.sval` vs `.str`) | Med × Med | pg18 uses `sval`; walker reads defensively (`typeof` checks) and simply collects nothing rather than crashing |
| Dep size / offline install (WASM binary in the package) | Med × Low | Committed lockfile; note in README that install needs registry access |
| Recursion blows the stack on hostile nesting | Low × Med | The parser hits its own depth limit first → parse error → 400 in Phase 02 |
| Adopting `@pgsql/types` node types churns on the next PG major | Med × Low | Deliberately keep the untyped permissive walk |

## Security Considerations
- Extraction alone changes **no** behaviour — nothing is rejected until Phase 02/03 wire the policy. Safe to land independently.
- The shared banned-function list must keep **both** consumers: parser scan (decoded names) and lexer scan (text). Removing the regex scan would reopen the gap for SQL the parser accepts but shapes differently.
- No SQL reaches the DB in this phase; `extractSqlRefs` performs no I/O.

## Next Steps
- Phase 02 consumes `extractSqlRefs` + `bannedFunctionName` to build the policy and adds the `deniedTables` config.
