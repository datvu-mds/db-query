/**
 * sql-lexer — a single, shared tokenizer that produces a "code-only" view of SQL.
 *
 * `stripToCode(sql)` returns a string of the SAME length where every character
 * inside a comment (`-- …`, slash-star), string literal (`'…'`, E`'…'`), quoted
 * identifier (`"…"`) or dollar-quoted body (`$tag$…$tag$`) is replaced by a space,
 * and every other (code) character is left untouched.
 *
 * Same-length blanking is deliberate: offsets stay stable, so downstream checks
 * (the multi-statement scan and the statement guard) can use trivial regexes/
 * indexOf on the stripped view without re-implementing the lexer. Both consumers
 * therefore read the SAME normalized SQL — they cannot drift, and neither can be
 * comment- or string-bypassed (`'pg_read_file('` becomes blanks, not a match).
 *
 * E-string handling is LOAD-BEARING, not cosmetic. In an E-string `\'` is an
 * escaped quote, so it does NOT terminate the literal. A tokenizer that only knows
 * the `''` form thinks the string is still open and swallows the rest of the input
 * — which historically smuggled a `COMMIT` past the single-statement guard and out
 * of the read-only transaction. The `E` must stand alone: in `value'x'` the
 * trailing `e` belongs to the identifier, not to the literal.
 *
 * Assumes `standard_conforming_strings = on` (Postgres default since 9.1): a
 * backslash is literal inside '…' and only escapes inside E'…'.
 *
 * `revealQuotedIdents` — quoted identifiers get OPPOSITE treatment depending on the
 * consumer. The multi-statement scanner must blank them (a `;` inside "…" is not a
 * separator). The banned-function scanner must NOT: Postgres resolves
 * `"pg_read_file"(…)` to the very same function, so blanking the name would hide the
 * call and let a read-mode token reach it. With this flag ON, only the wrapping `"`
 * chars are blanked and the inner identifier text is kept, so the function scan sees
 * the real name. Comments, strings and dollar-bodies are blanked either way (a
 * literal can never be a function call, so keeping them would only add false
 * positives). Same-length is preserved in both modes.
 */

export interface StripOptions {
    /** Keep double-quoted identifier CONTENTS (blank only the `"`); default false. */
    revealQuotedIdents?: boolean;
}

// Postgres dollar-quote tag: empty ($$) or an identifier that can't start with a digit.
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/;

/** Identifier char — used to tell an `E'…'` prefix from the tail of a word. */
function isIdentChar(c: string | undefined): boolean {
    return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

/**
 * Blank every non-code span, preserving length. Single left-to-right O(n) scan;
 * each branch mirrors `assertSingleStatement`'s structure but, instead of acting
 * on a `;`, records the skipped span so it can be overwritten with spaces.
 */
export function stripToCode(sql: string, opts: StripOptions = {}): string {
    // Mutable same-length copy; code chars stay in place, non-code spans get blanked.
    const out = sql.split('');
    const blank = (from: number, to: number): void => {
        for (let k = from; k < to && k < out.length; k++) out[k] = ' ';
    };
    // Blank only the `"` delimiters in a span, keeping the identifier text (used when
    // revealing quoted identifiers so a quoted function name stays scannable).
    const blankQuotesOnly = (from: number, to: number): void => {
        for (let k = from; k < to && k < out.length; k++) if (out[k] === '"') out[k] = ' ';
    };

    const n = sql.length;
    let i = 0;
    while (i < n) {
        const c = sql[i];

        // Line comment: `-- …` to end of line.
        if (c === '-' && sql[i + 1] === '-') {
            const start = i;
            i += 2;
            while (i < n && sql[i] !== '\n') i++;
            blank(start, i);
            continue;
        }
        // Block comment: `/* … */`.
        if (c === '/' && sql[i + 1] === '*') {
            const start = i;
            i += 2;
            while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
            i += 2; // consume the closing */ (blank() clamps if it overshoots n)
            blank(start, i);
            continue;
        }
        // Single-quoted string (with '' escape); E-prefixed strings also honor `\'`.
        if (c === "'") {
            const start = i;
            const escapeString = (sql[i - 1] === 'E' || sql[i - 1] === 'e') && !isIdentChar(sql[i - 2]);
            i++;
            while (i < n) {
                if (escapeString && sql[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (sql[i] === "'") {
                    if (sql[i + 1] === "'") {
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            blank(start, i);
            continue;
        }
        // Double-quoted identifier (with "" escape).
        if (c === '"') {
            const start = i;
            i++;
            while (i < n) {
                if (sql[i] === '"') {
                    if (sql[i + 1] === '"') {
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            // Reveal mode keeps the inner name (blanks only the quotes) so a quoted
            // function call like "pg_read_file"(…) is still visible to the scan.
            if (opts.revealQuotedIdents) blankQuotesOnly(start, i);
            else blank(start, i);
            continue;
        }
        // Dollar-quoted body ($tag$ … $tag$).
        if (c === '$') {
            const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
            if (tag) {
                const start = i;
                const end = sql.indexOf(tag, i + tag.length);
                i = end === -1 ? n : end + tag.length;
                blank(start, i);
                continue;
            }
        }

        // Code char: leave it untouched in `out`.
        i++;
    }

    return out.join('');
}
