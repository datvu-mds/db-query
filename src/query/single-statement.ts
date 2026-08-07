/**
 * assertSingleStatement — reject `;`-separated multi-statement SQL before it
 * reaches the engine. A single trailing `;` is allowed; a `;` followed by more
 * SQL is rejected. Semicolons inside string literals ('...'), escape strings
 * (E'...'), quoted identifiers ("..."), line comments (-- ), block comments
 * (slash-star) and dollar-quoted bodies ($tag$...$tag$) are ignored.
 *
 * It works on the shared `stripToCode` view (see sql-lexer.ts): comments/strings/
 * dollar-bodies are blanked to spaces first, so only a TOP-LEVEL `;` can remain —
 * which makes the check a one-line `indexOf`, and shares one tokenizer with the
 * statement guard so the two can never disagree about what is code vs. a literal.
 *
 * This is a CONSERVATIVE guard (it may reject exotic-but-valid input) and it is
 * DEFENCE IN DEPTH ONLY. The structural defense is the extended wire protocol
 * (see PostgresDriver.exec), under which the SERVER rejects multi-statement text
 * outright — this scanner just fails such input earlier, with a 400, before any
 * DB contact. Never let it become the only thing standing between a read-only
 * token and a smuggled `COMMIT`.
 *
 * Assumes `standard_conforming_strings = on` (the Postgres default since 9.1):
 * a backslash is literal inside '...' and only escapes inside E'...'.
 */
import { stripToCode } from './sql-lexer.js';

export function assertSingleStatement(sql: string): void {
    const code = stripToCode(sql);
    // Only a top-level `;` survives blanking. A single trailing one (nothing but
    // whitespace after — comments are already spaces) is allowed; anything else is
    // a second statement.
    const idx = code.indexOf(';');
    if (idx !== -1 && code.slice(idx + 1).trim() !== '') {
        throw new Error('Multiple SQL statements are not allowed (one statement per request).');
    }
}
