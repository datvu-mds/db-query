/**
 * relation-guard — parses each statement with the REAL Postgres parser
 * (libpg-query, WASM) and answers "which relations and functions does this SQL
 * actually touch?". The parser gives DECODED identifiers, so `U&"\0070g_read_file"`
 * arrives as `pg_read_file` and unquoted names arrive case-folded — closing the
 * unicode-escape gap a lexer cannot. Only `RangeVar` nodes are relation references;
 * we deliberately do NOT pattern-match schema words in the tree, because every
 * `::int` cast carries `TypeName.names = ['pg_catalog','int4']` and would false-positive.
 *
 * This file has two halves: extraction (below) and policy (assertRelationsAllowed,
 * added in Phase 02). Extraction alone changes no behaviour and performs no I/O.
 */
import { parse } from 'libpg-query';
import { BadRequestError, ForbiddenError } from './gateway-errors.js';
import { capabilityAllows } from '../auth/token-auth.js';
import { bannedFunctionName } from './banned-functions.js';

export interface RelationRef {
    schema?: string;
    relation: string;
}
export interface SqlRefs {
    relations: RelationRef[];
    functions: string[];
}

/**
 * Parse ONE statement (single-statement is guaranteed upstream) and return every
 * referenced relation (CTE-aware) plus every called function name (decoded).
 * Throws the raw parser error on unparseable SQL — Phase 02 converts that to a 400.
 */
export async function extractSqlRefs(sql: string): Promise<SqlRefs> {
    const tree = await parse(sql); // { version, stmts: [{ stmt }] }
    const out: SqlRefs = { relations: [], functions: [] };
    walk(tree.stmts, new Set<string>(), out);
    return out;
}

type Node = Record<string, unknown>;

/**
 * Recursively collect RangeVar relations and FuncCall names. `scope` carries the CTE
 * names visible at this point in the tree — an unqualified relation whose name is in
 * scope is a CTE reference, not a table, so it is skipped.
 */
function walk(node: unknown, scope: ReadonlySet<string>, out: SqlRefs): void {
    if (Array.isArray(node)) {
        for (const n of node) walk(n, scope, out);
        return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Node;

    // Write/create TARGET relations — INSERT/UPDATE/DELETE/MERGE `.relation` and
    // `SELECT … INTO`'s `.intoClause.rel` — are emitted by the parser as a BARE RangeVar:
    // a statically-typed field carrying `relname`/`schemaname` directly, with no
    // `{ RangeVar: … }` wrapper key. The key-based branch below therefore never sees them,
    // which would let a write-mode token write cross-tenant or to a denied table. Detect
    // that shape here and collect it UNCONDITIONALLY — a write target is a real relation
    // even when its name matches an enclosing CTE (you cannot write into a CTE), so
    // CTE-scope skipping must NOT apply. Read-path relations (FROM/JOIN/subquery/CTE body)
    // are always wrapped in `{ RangeVar: … }`, so they take the scope-aware branch below
    // and this never double-counts them (a wrapper object has no top-level `relname`).
    if (typeof obj.relname === 'string' && obj.relname !== '') pushRelation(obj, out);

    // A node carrying WITH opens a CTE scope for its whole subtree.
    let childScope = scope;
    const withClause = obj.withClause as Node | undefined;
    if (withClause && Array.isArray(withClause.ctes)) childScope = walkWith(withClause, scope, out);

    for (const [key, value] of Object.entries(obj)) {
        if (key === 'withClause') continue; // consumed above
        if (key === 'RangeVar') {
            collectRelation(value as Node, childScope, out);
            continue;
        }
        if (key === 'FuncCall') collectFunction(value as Node, out); // fall through: walk args too
        walk(value, childScope, out);
    }
}

/**
 * PG scoping: cte[i]'s body sees cte[0..i-1] (plus itself when RECURSIVE); the main
 * query body sees all of them. Adding each name AFTER walking its own body is what
 * stops a later CTE name from masking a real table referenced earlier — e.g.
 * `WITH a AS (SELECT * FROM "user"), "user" AS (SELECT 1) SELECT * FROM a` must still
 * surface the real `user` table.
 */
function walkWith(withClause: Node, scope: ReadonlySet<string>, out: SqlRefs): ReadonlySet<string> {
    const recursive = withClause.recursive === true;
    const names = new Set(scope);
    for (const node of withClause.ctes as unknown[]) {
        const cte = (node as Node).CommonTableExpr as Node | undefined;
        if (!cte) {
            walk(node, names, out);
            continue;
        }
        const name = typeof cte.ctename === 'string' ? cte.ctename : '';
        // A RECURSIVE cte can reference itself; a non-recursive one cannot.
        walk(cte.ctequery, recursive && name ? new Set([...names, name]) : names, out);
        if (name) names.add(name);
    }
    return names;
}

/** Push a RangeVar-shaped node as a relation ref (schema undefined when unqualified). */
function pushRelation(rv: Node, out: SqlRefs): void {
    const relation = typeof rv.relname === 'string' ? rv.relname : '';
    if (!relation) return;
    const schema = typeof rv.schemaname === 'string' && rv.schemaname !== '' ? rv.schemaname : undefined;
    out.relations.push({ schema, relation });
}

/** Tagged (read-path) RangeVar: skip it only when it is really an in-scope CTE name. */
function collectRelation(rv: Node, scope: ReadonlySet<string>, out: SqlRefs): void {
    const relation = typeof rv.relname === 'string' ? rv.relname : '';
    if (!relation) return;
    const unqualified = !(typeof rv.schemaname === 'string' && rv.schemaname !== '');
    if (unqualified && scope.has(relation)) return; // CTE reference, not a table
    pushRelation(rv, out);
}

/** funcname: [{String:{sval:'pg_catalog'}},{String:{sval:'pg_read_file'}}] → last part.
 *  The qualifier is ignored — `pg_catalog.pg_read_file` and `pg_read_file` are the same. */
function collectFunction(fc: Node, out: SqlRefs): void {
    const parts = Array.isArray(fc.funcname) ? fc.funcname : [];
    const last = parts[parts.length - 1] as Node | undefined;
    const sval = (last?.String as Node | undefined)?.sval;
    if (typeof sval === 'string' && sval !== '') out.functions.push(sval);
}

// ── Policy ──────────────────────────────────────────────────────────────────────

export interface RelationPolicy {
    /** Effective (already authorized) schema — the target of unqualified refs. */
    schema: string;
    /** Token caps; ['*'] = any non-system schema. Caller passes caps.schemas. */
    allowedSchemas: string[];
    /** Per-datasource denied tables: `table` | `schema.table`. */
    deniedTables: string[];
}

const METADATA_HINT =
    'Use list_schemas / list_tables / describe_table for structure — run_query does not expose catalog or information_schema relations.';

/** pg_catalog, pg_toast, pg_temp_*, information_schema — the same rule as
 *  IntrospectService.visibleSchema, exported so the two policies cannot drift. */
export function isSystemSchema(name: string): boolean {
    const n = name.toLowerCase();
    return n === 'information_schema' || n.startsWith('pg_');
}

/**
 * Parse the statement and reject, per referenced relation: system-catalog schemas,
 * schemas outside the token's caps, implicit `pg_%` catalog names, and denied tables;
 * plus any banned function (parser path — closes the unicode-escape gap). Fail-closed:
 * SQL this gateway cannot parse is SQL it cannot police, so it is rejected. Performs
 * no I/O; throws BadRequestError (400) or ForbiddenError (403).
 */
export async function assertRelationsAllowed(sql: string, policy: RelationPolicy): Promise<void> {
    let refs: SqlRefs;
    try {
        refs = await extractSqlRefs(sql);
    } catch (err) {
        throw new BadRequestError(`SQL could not be parsed, so it cannot be checked: ${(err as Error).message}`);
    }

    for (const name of refs.functions) {
        if (bannedFunctionName(name)) throw new BadRequestError(`Function "${name}" is not permitted by this gateway.`);
    }

    for (const ref of refs.relations) {
        if (ref.schema) {
            if (isSystemSchema(ref.schema))
                throw new BadRequestError(`Relation "${ref.schema}.${ref.relation}" is not readable through run_query. ${METADATA_HINT}`);
            if (!capabilityAllows(policy.allowedSchemas, ref.schema))
                throw new ForbiddenError(`schema "${ref.schema}" not permitted`); // same wording as authorize()
        } else if (/^pg_/i.test(ref.relation)) {
            // Unqualified pg_% resolves to pg_catalog (implicitly first on search_path).
            throw new BadRequestError(`Relation "${ref.relation}" is not readable through run_query. ${METADATA_HINT}`);
        }

        const effective = ref.schema ?? policy.schema;
        if (isDenied(effective, ref.relation, policy.deniedTables))
            throw new BadRequestError(`Relation "${effective}.${ref.relation}" is on this datasource's denied-table list.`);
    }
}

/** `table` matches in ANY schema; `schema.table` must match both. Case-insensitive:
 *  PG folds unquoted identifiers to lower case and a denylist should over-block. */
function isDenied(schema: string, relation: string, denied: string[]): boolean {
    const s = schema.toLowerCase();
    const r = relation.toLowerCase();
    return denied.some((entry) => {
        const e = entry.toLowerCase();
        const dot = e.indexOf('.');
        return dot === -1 ? e === r : e.slice(0, dot) === s && e.slice(dot + 1) === r;
    });
}
