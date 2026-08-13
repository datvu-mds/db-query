/**
 * env-file — the ONE env-file parser in this codebase.
 *
 * There is no in-process dotenv here: `.env` is read by `node --env-file-if-exists=.env`
 * at boot. But two consumers must parse env text *themselves* — the reload orchestrator
 * (`reload.ts`, re-reading `.env` on SIGHUP without mutating `process.env`) and the
 * datasource directory reader (`datasources-dir.ts`, reading `datasources.d/*.env`). Both
 * go through this function on purpose. Two parsers with different quoting rules would put
 * the same file's PASSWORD into the pool two different ways depending on which path read
 * it — the "shared definitions that must not drift" failure this repo keeps designing
 * against (see `banned-functions.ts`, `stripToCode`, `capabilityAllows`).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * TWO DIALECTS, AND WHY THE ASYMMETRY IS THE POINT
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * One function, two rule sets, because the two consumers answer to different authorities:
 *
 *   'node'        `.env`               — parsed by `node --env-file` at BOOT and by us on
 *                                        RELOAD. Node's rules are not ours to choose. The
 *                                        only correct behaviour is whatever node does.
 *   'credential'  `datasources.d/*.env` — parsed by NOTHING but this function, ever. No
 *                                        boot behaviour to match, so the rules can be the
 *                                        ones that are safest for a file full of passwords.
 *
 * DO NOT "simplify" this into one rule set. It was one rule set, and the merge produced
 * three verified failures, all from the same root: `.env` meaning something different
 * depending on how the process started (Design Decision 6 forbids exactly that).
 *
 *   1. PERMANENT POOL CHURN. `DS_MAIN_PASSWORD=p@ss # rotated` boots as `p@ss` (node
 *      truncates at the `#`) and reloaded as the whole string. The deep-compare reports
 *      "changed" on an UNCHANGED file, rebuilds the pool with a wrong password, and fails
 *      the ping — on every reload, forever.
 *   2. A KEY BOOT NEVER SAW GOING LIVE (the serious one). Node reads a quoted value that
 *      spans lines as ONE string, so a `TOKEN_X_SECRET=…` line sitting inside it is inert
 *      text. A line-at-a-time parser promotes it to a real top-level key — a credential
 *      that boot never saw becoming live on SIGHUP.
 *   3. UNCLEARABLE WARNINGS. A BOM leaves node's first key as `\uFEFFHOST`, so `HOST` is
 *      simply unset at boot. Stripping the BOM here makes `HOST` appear on reload only,
 *      which reads as a permanent "changed" no edit to the file can clear.
 *
 * The reasoning that argued for the safer rules (a `#` must not truncate a password; a BOM
 * should be stripped) is still correct — for `datasources.d/`, where nothing else parses
 * the file. It is wrong for `.env`, where NOT matching node creates the very hazard it was
 * trying to avoid. Hence: per-consumer, not global.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHERE THE DIALECTS DIFFER  (node column captured from a real `node --env-file` run,
 * v22.21.1 — see the header of `test/env-file.test.ts` for the one-liner to re-capture)
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 *   input                    'node'                        'credential'
 *   A=p@ss #note             `p@ss`      (# ends value)    `p@ss #note`   (# is a char)
 *   A=`tick`                 `tick`      (backtick quotes) `` `tick` ``   (not a quote)
 *   A="line\nbreak"          `line`⏎`break`  (\n expands)  `line\nbreak`  (verbatim)
 *   A="v" junk               `v`   (post-quote junk gone)  `"v" junk`     (not balanced)
 *   BOM + `H=v` on line 1    H unset     (BOM kept on key) `H`=`v`        (BOM stripped)
 *   A="l1⏎l2"                `l1`⏎`l2`   (one value)       REFUSED, fails closed
 *
 * Already identical in both, and must stay that way: `KEY=` ⇒ empty string, split on the
 * FIRST `=`, `export ` prefix, full-line `#` comments, CRLF, duplicate key ⇒ last wins, no
 * `${VAR}` interpolation, an unbalanced quote with nothing to close it kept verbatim.
 *
 * DELIBERATE DIVERGENCES FROM NODE, kept in BOTH dialects — each is safe because it can
 * only ever DROP a key, never invent one (see the subset invariant below):
 *   - `KEY_RE`. Node accepts `HO ST`, `2HOST`, `A-B` as variable names. Nothing this
 *     gateway reads can be named that (`DS_*`, `TOKEN_*`, `PORT`, …), so refusing them
 *     cannot change which config key resolves — and it keeps the one hygiene line that
 *     stops a garbage or injected identifier from reaching the merged map.
 *   - `export` is stripped only before SPACES. Node's key for `export\tA=1` is
 *     `export\tA`; a `\s`-based strip would yield `A` — inventing the very kind of key
 *     failure chain 2 is about.
 *
 * THE INVARIANT THAT MAKES RESIDUAL DIVERGENCE HARMLESS: for any input, the keys this
 * function produces in 'node' dialect are a SUBSET of node's, and shared keys hold equal
 * values. Subset is enough — node setting a key we drop leaves boot's value untouched in
 * `process.env`; us setting a key node never saw is chain 2. Any future change here must
 * preserve the direction, not just the test list.
 *
 * NOT SUPPORTED IN EITHER DIALECT — each omission is a decision, not a gap:
 *   - `${VAR}` interpolation. Expansion would let one datasource file read another
 *     process's environment into its own value; there is no need for it and it only adds
 *     a way for a value to be something other than what the file plainly says.
 *   - Escapes beyond node's own `\n`-inside-double-quotes. A password containing a
 *     backslash must survive intact.
 *
 * Certificates or other multi-line secrets, if they are ever needed, belong in a file
 * referenced by path — not inline in an env file.
 */

/** A valid env identifier. Deliberately strict: anything else is a typo or an injection attempt. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Node strips `export` only when SPACES follow it — see the divergence note in the header. */
const EXPORT_PREFIX = 'export ';

/**
 * Every strict-mode error names the LINE NUMBER and stops there.
 *
 * The message is not for us: `datasources-dir.ts` prefixes the file path and `reload.ts`
 * writes the result to the reload log, which is normally shipped to an aggregator. These
 * files are mode-600 because their contents are credentials; the log is not. Echoing the
 * offending line put `PASSWORD "hunter2"` straight into it, and the sibling error leaked
 * the key half the same way — both violating the "names only, never values" rule
 * `reload.ts` states three times.
 *
 * An operator with the file open needs the line number and nothing else. DO NOT "improve"
 * any of these errors by appending the content; all three are uniform precisely so that a
 * future reader cannot conclude one of them is the safe exception.
 */
const CONTENT_OMITTED = 'line content omitted — it may be a credential';

export type EnvDialect = 'node' | 'credential';

export interface ParseEnvOptions {
    /**
     * How to treat a line that is neither blank, a comment, nor a valid `KEY=value`.
     *
     * `false` (default) — skip it. This is exactly what `node --env-file` does (verified:
     * a line with no `=` is skipped and parsing CONTINUES with the next one), and the
     * `.env` consumer MUST match it: a stricter reload would refuse a SIGHUP on a file
     * that has been booting fine for weeks.
     *
     * `true` — throw, naming the line number. `datasources.d/*.env` opts in, because there
     * node never parses these files, so there is no boot behaviour to match, and a silent
     * skip is dangerous in a way it is not for `.env`: `DENIED_TABLES billing_accounts`
     * (missing `=`) yields no key at all, so the unknown-key rejection never sees it and a
     * denylist quietly disappears. Fail closed instead.
     */
    strict?: boolean;

    /**
     * Which rule set to parse VALUES with — the header explains why there are two.
     *
     * Defaults to `strict ? 'credential' : 'node'`, which is what makes the two existing
     * call sites correct without either of them naming a dialect: `reload.ts` calls
     * `parseEnvFile(text)` for `.env` and gets node's rules; `datasources-dir.ts` calls
     * `parseEnvFile(text, { strict: true })` for a credential file and gets the safer ones.
     *
     * `strict` and `dialect` are otherwise ORTHOGONAL — `strict` governs only what happens
     * to an unparseable line, `dialect` only what a value means. The default derivation is
     * their single point of contact, so a strict parse of `.env` must say
     * `{ strict: true, dialect: 'node' }` explicitly rather than relying on it.
     */
    dialect?: EnvDialect;
}

/**
 * Parse env-file text into a plain key→value map. Values are returned as written (after
 * quote handling); every type conversion stays in load-config.ts, so `bool()` /
 * `boolSecureDefault()` remain the single place a string becomes a boolean.
 */
export function parseEnvFile(text: string, opts: ParseEnvOptions = {}): Record<string, string> {
    const strict = opts.strict === true;
    const dialect: EnvDialect = opts.dialect ?? (strict ? 'credential' : 'node');
    const nodeCompat = dialect === 'node';

    // CRLF → LF for the WHOLE text before anything is split, which is the order node uses.
    // Doing it per-line (the old `/\r$/` strip) leaves a stray `\r` embedded inside a value
    // that spans lines, so a CRLF file and an LF file would disagree about a password.
    let body = text.replace(/\r\n/g, '\n');

    // A BOM is stripped ONLY for credential files, where leaving it would make the first
    // key `\uFEFFHOST` and silently drop the first line. For `.env` that same "fix" is the
    // bug: node leaves the BOM attached, so the key it sets is `\uFEFFHOST` and `HOST` is
    // unset at boot. Stripping it here would make `HOST` exist on reload only — chain 3.
    // KEY_RE then rejects the BOM-prefixed key, so we drop it exactly where node keeps a
    // key no config lookup can ever name. Same observable outcome, subset direction.
    if (!nodeCompat && body.charCodeAt(0) === 0xfeff) body = body.slice(1);

    // Null-prototype accumulator: a file containing `__proto__=x` must not reach
    // Object.prototype. The spread at the end hands back an ordinary object (so callers
    // and assert.deepStrictEqual see the shape they expect) while the spread's
    // CreateDataProperty semantics keep `__proto__` an own property rather than a setter
    // call.
    const out: Record<string, string> = Object.create(null);

    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;

        const eq = raw.indexOf('=');
        if (eq < 0) {
            if (strict) throw new Error(`line ${i + 1}: expected KEY=VALUE, no "=" on this line (${CONTENT_OMITTED})`);
            continue;
        }

        // Split first, THEN strip `export` — node reads the prefix off the key, not off the
        // line, so `export A="x=y"` and `A=export b` both land where node puts them.
        let key = trimBlanks(raw.slice(0, eq));
        if (key.startsWith(EXPORT_PREFIX)) key = trimBlanks(key.slice(EXPORT_PREFIX.length));
        if (!KEY_RE.test(key)) {
            if (strict) {
                throw new Error(
                    `line ${i + 1}: key is not a valid env identifier — expected letters, digits and underscore, not starting with a digit (${CONTENT_OMITTED})`,
                );
            }
            continue;
        }

        const valueRaw = raw.slice(eq + 1);
        // Blanks between `=` and the value are node's to trim, quoted or not: `A=  "q"` is
        // `q`. `rest` stays a SUFFIX of `raw`, so its offset in the line is derivable below.
        const rest = valueRaw.replace(/^[ \t]+/, '');

        const quote = openingQuote(rest, nodeCompat);
        if (quote !== undefined && rest.indexOf(quote, 1) < 0) {
            // A quote opens and does not close on this line. Node's rule is to look for the
            // closer in the REST OF THE FILE, so the value may span lines. Both dialects
            // run this search: they may disagree about whether to ACCEPT a multi-line value,
            // but they must never disagree about its EXTENT — that disagreement is exactly
            // how text node holds inside one string becomes a live top-level key here.
            const contentStart = raw.length - rest.length + 1; // just past the opening quote
            const end = findClosingQuote(lines, i, contentStart, quote);
            if (end !== undefined) {
                if (nodeCompat) {
                    out[key] = spanValue(lines, i, contentStart, end, quote);
                } else if (strict) {
                    // Fail CLOSED. Nothing in `DatasourceConfig` is multi-line, so this is
                    // either a stray quote in a password or a certificate someone tried to
                    // paste inline; guessing which would put the wrong secret in a pool.
                    throw new Error(
                        `line ${i + 1}: a quoted value that is not closed on the same line is not supported in a datasource file (${CONTENT_OMITTED})`,
                    );
                }
                // Lenient credential parse: the value is dropped, but the span is still
                // CONSUMED — the lines inside it must not be read as assignments.
                i = end.line;
                continue;
            }
            // Nothing closes it anywhere. Node keeps the rest of the line verbatim, opening
            // quote included, and `unquote()` leaves an unbalanced quote alone, so both
            // dialects already agree. Fall through.
        }

        out[key] = nodeCompat ? nodeValue(rest) : unquote(valueRaw.trim());
    }

    return { ...out };
}

/** The quote character a value opens with, if any. Backticks count only for node. */
function openingQuote(rest: string, nodeCompat: boolean): string | undefined {
    const c = rest[0];
    if (c === '"' || c === "'") return c;
    if (nodeCompat && c === '`') return c;
    return undefined;
}

/** First occurrence of `quote` at or after `startCol` on `startLine`, else on a later line. */
function findClosingQuote(lines: string[], startLine: number, startCol: number, quote: string): { line: number; col: number } | undefined {
    const sameLine = lines[startLine].indexOf(quote, startCol);
    if (sameLine >= 0) return { line: startLine, col: sameLine };
    for (let l = startLine + 1; l < lines.length; l++) {
        const col = lines[l].indexOf(quote);
        if (col >= 0) return { line: l, col };
    }
    return undefined;
}

/** The text between an opening quote and a closing quote on a later line, newlines intact. */
function spanValue(lines: string[], startLine: number, startCol: number, end: { line: number; col: number }, quote: string): string {
    if (end.line === startLine) return expandIfDouble(lines[startLine].slice(startCol, end.col), quote);
    const parts = [lines[startLine].slice(startCol)];
    for (let l = startLine + 1; l < end.line; l++) parts.push(lines[l]);
    parts.push(lines[end.line].slice(0, end.col));
    return expandIfDouble(parts.join('\n'), quote);
}

/**
 * Node's value rules for a single line.
 *
 * The `#` truncation here is NOT an endorsement of inline comments — it is node's
 * behaviour, and `.env` is parsed by node at boot. Diverging is what churns a pool.
 */
function nodeValue(rest: string): string {
    const quote = openingQuote(rest, true);
    if (quote !== undefined) {
        const close = rest.indexOf(quote, 1);
        // Everything after the closing quote is discarded, comment or not: `A="v" junk` is `v`.
        if (close >= 0) return expandIfDouble(rest.slice(1, close), quote);
        return rest; // unterminated with no closer anywhere: kept verbatim, quote included
    }
    const hash = rest.indexOf('#');
    return trimBlanks(hash >= 0 ? rest.slice(0, hash) : rest);
}

/**
 * Trim SPACES and TABS — what node trims around a key or an unquoted value, and no more.
 *
 * Not `String.prototype.trim()`: JS also strips U+FEFF, so `.trim()` would quietly repair
 * a BOM into the valid key `HOST` while node's key stays `﻿HOST` and leaves `HOST`
 * unset. That is chain 3 arriving through the back door, from a call that looks like
 * ordinary hygiene.
 */
function trimBlanks(s: string): string {
    return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

/**
 * Node expands the two-character sequence `\n` into a newline inside DOUBLE quotes only —
 * not in single quotes, not in backticks, and no other escape (`\t` stays literal). The
 * replacement is deliberately naive because node's is: `"c:\\nope"` yields `c:\` + newline.
 */
function expandIfDouble(value: string, quote: string): string {
    return quote === '"' ? value.replace(/\\n/g, '\n') : value;
}

/**
 * Strip ONE layer of matching outer quotes — the 'credential' dialect's value rule.
 * Unbalanced quotes are left alone rather than repaired: `PASSWORD="abc` is far more likely
 * to be a real password containing a quote than a typo, and guessing would change a
 * credential.
 */
function unquote(value: string): string {
    if (value.length >= 2) {
        const first = value[0];
        if ((first === '"' || first === "'") && value[value.length - 1] === first) {
            return value.slice(1, -1);
        }
    }
    return value;
}
