/**
 * statement-guard — a mode-aware allowlist on the leading keyword plus a
 * banned-function scan, both over the shared `stripToCode` view.
 *
 * WHY (see docs/risks/2026-07-29-…): `BEGIN TRANSACTION READ ONLY` blocks DB data
 * writes but NOT `COPY … TO PROGRAM/'file'`, `pg_read_file`, backend signals or WAL
 * messages — all catastrophic under a superuser role. This guard rejects those at
 * the app layer, before any DB contact, so a read-mode call cannot reach them
 * regardless of the DB role's privileges.
 *
 * It is DEFENCE IN DEPTH — it ships *with*, never *instead of*, the non-superuser
 * DB role (README → "The read-only guarantee lives in the database"). Denylists are
 * inherently fragile; the role is the real guarantee.
 *
 * Design: an ALLOWLIST of leading keywords is stronger than a keyword denylist —
 * anything not explicitly permitted (COPY/CALL/DO/SET/ALTER/CREATE/…) is rejected
 * with no per-keyword list to maintain. Banned *functions* still need an explicit
 * scan because they hide inside allowed statements (e.g. `SELECT pg_read_file(…)`).
 * Operating on `stripToCode` makes both immune to comment/string bypass and to
 * string-literal false positives (`SELECT 'pg_read_file(' AS note` is blanked). The
 * function scan reads the ident-REVEALING view so a quoted call `"pg_read_file"(…)`
 * — which Postgres resolves to the same function — is still caught.
 *
 * The `U&"\0070g_read_file"` unicode-ESCAPE identifier that a lexer cannot decode is
 * now caught by the relation guard (relation-guard.ts), which runs the SAME banned
 * list against the real parser's DECODED names. This text scan stays as belt-and-
 * braces for SQL the parser accepts but shapes differently; both share one list
 * (banned-functions.ts) so they cannot drift. The non-superuser DB role, which holds
 * no privilege to run these, remains the durable fix (see the runbook / risk report).
 */
import { stripToCode } from './sql-lexer.js';
import { BadRequestError } from './gateway-errors.js';
import { BANNED_CALL_PATTERNS } from './banned-functions.js';

/** Read mode: pure retrieval statements only. `SHOW` is intentionally NOT here — it
 *  leaks server settings (`SHOW all` → data_directory, config_file, …) and exposes no
 *  relations for the relation guard to police, so it was removed from the allowlist.
 *  Read a specific setting with `current_setting('name')` or `SELECT version()`. */
const ALLOW_READ = ['SELECT', 'WITH', 'EXPLAIN', 'VALUES', 'TABLE'] as const;
/** Write mode: the read set plus the data-modifying statements. */
const ALLOW_WRITE = [...ALLOW_READ, 'INSERT', 'UPDATE', 'DELETE', 'MERGE'] as const;

const HINT = 'If this datasource must run such statements, set DS_<NAME>_ALLOW_UNSAFE_STATEMENTS=true (and ensure its DB role is trusted).';

/**
 * Reject a statement whose leading keyword is not allowlisted, or that calls a
 * banned function. Throws BadRequestError (→ 400) with an actionable hint; makes
 * no DB contact. No-op is the caller's job — QueryService skips this entirely when
 * the datasource sets `allowUnsafeStatements`.
 */
export function assertStatementAllowed(sql: string, opts: { write: boolean }): void {
    // Leading-keyword check uses the fully-blanked view: a dangerous statement
    // keyword (COPY/DO/…) cannot be quoted into execution, so quoted idents stay
    // blanked here. First run of identifier chars is the leading keyword.
    const code = stripToCode(sql);
    const leading = /[a-z_]+/i.exec(code)?.[0]?.toUpperCase();
    const allowed: readonly string[] = opts.write ? ALLOW_WRITE : ALLOW_READ;
    if (!leading || !allowed.includes(leading)) {
        throw new BadRequestError(
            `Statement type "${leading ?? '(empty)'}" is not permitted by this gateway. ` +
                `Allowed (${opts.write ? 'write' : 'read'} mode): ${allowed.join(', ')}. ${HINT}`,
        );
    }

    // Banned-function scan uses the ident-REVEALING view: `SELECT "pg_read_file"(…)`
    // resolves to the same function as the unquoted form, so the quoted name must
    // stay visible or the call slips through. Functions can hide inside an allowed
    // statement, so scan the whole body.
    const fnScanCode = stripToCode(sql, { revealQuotedIdents: true });
    for (const re of BANNED_CALL_PATTERNS) {
        const m = re.exec(fnScanCode);
        if (m) {
            throw new BadRequestError(`Function "${m[1]}" is not permitted by this gateway. ${HINT}`);
        }
    }
}
