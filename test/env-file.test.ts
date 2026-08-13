import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvFile } from '../src/config/env-file.js';

/**
 * Two dialects, two consumers — see the header of `src/config/env-file.ts` for WHY.
 *
 *   parseEnvFile(text)                      → 'node' dialect      (`.env`, lenient)
 *   parseEnvFile(text, { strict: true })    → 'credential' dialect (`datasources.d/*.env`)
 *
 * Every expectation in the `node dialect` block below was captured from a real
 * `node --env-file=` run on v22.21.1, not from reading the docs. Re-capture with:
 *
 *   printf 'K=v #c\n' > /tmp/t.env
 *   node --env-file=/tmp/t.env -e 'console.log(JSON.stringify(process.env.K))'
 */

// ── dialect-neutral ────────────────────────────────────────────────────────────

test('parses KEY=value and trims surrounding whitespace', () => {
    const out = parseEnvFile('HOST=warehouse.internal\n  PORT = 5432  \n');
    assert.deepEqual(out, { HOST: 'warehouse.internal', PORT: '5432' });
});

test('skips blank lines and full-line comments', () => {
    const out = parseEnvFile(['# datasources.d/warehouse.env', '', '   ', 'HOST=h', '   # trailing note', 'USER=u'].join('\n'));
    assert.deepEqual(out, { HOST: 'h', USER: 'u' });
});

test('strips an `export ` prefix', () => {
    const out = parseEnvFile('export HOST=h\nexport   USER=u\n');
    assert.deepEqual(out, { HOST: 'h', USER: 'u' });
});

test('SECURITY: `export` is stripped only before SPACES, matching node', () => {
    // node --env-file on `export\tA=1` produces the key "export\tA", not "A". Stripping a
    // tab-separated `export` would invent a key node never set — the one direction that
    // turns a line node treats as junk into a live setting on reload.
    for (const dialect of ['node', 'credential'] as const) {
        assert.deepEqual(parseEnvFile('export\tHOST=h\nUSER=u\n', { dialect }), { USER: 'u' });
    }
});

test('strips single and double quotes, preserving the value verbatim inside them', () => {
    const out = parseEnvFile(['A="double quoted"', "B='single quoted'", 'C="  padded  "', 'D="has # hash"', "E='has = equals'"].join('\n'));
    assert.deepEqual(out, {
        A: 'double quoted',
        B: 'single quoted',
        C: '  padded  ', // inner whitespace survives; only the outside was trimmed
        D: 'has # hash',
        E: 'has = equals',
    });
});

test('KEY= yields an empty string (loader trims it to undefined ⇒ zod default applies)', () => {
    const out = parseEnvFile('PORT=\nHOST=h\nSSL=""\n');
    assert.equal(out.PORT, '');
    assert.equal(out.SSL, '');
    assert.equal(out.HOST, 'h');
});

test('splits on the FIRST = so values may contain = and spaces', () => {
    const out = parseEnvFile('PASSWORD=a=b=c\nDENIED_TABLES=billing_accounts, api_keys\n');
    assert.equal(out.PASSWORD, 'a=b=c');
    assert.equal(out.DENIED_TABLES, 'billing_accounts, api_keys');
});

test('does NOT interpolate ${VAR} in either dialect', () => {
    for (const dialect of ['node', 'credential'] as const) {
        assert.equal(parseEnvFile('A=${HOME}/x\n', { dialect }).A, '${HOME}/x');
    }
});

test('tolerates CRLF line endings', () => {
    assert.deepEqual(parseEnvFile('HOST=h\r\nUSER=u\r\n'), { HOST: 'h', USER: 'u' });
    assert.deepEqual(parseEnvFile('HOST=h\r\nUSER=u\r\n', { dialect: 'credential' }), { HOST: 'h', USER: 'u' });
});

test('a repeated key keeps the last assignment', () => {
    assert.equal(parseEnvFile('HOST=first\nHOST=last\n').HOST, 'last');
});

test('lenient (default) skips an unparseable line — same rule node --env-file applies at boot', () => {
    const out = parseEnvFile('HOST=h\nDENIED_TABLES billing_accounts\nUSER=u\n');
    assert.deepEqual(out, { HOST: 'h', USER: 'u' });
});

test('lenient skips an invalid key instead of throwing', () => {
    assert.deepEqual(parseEnvFile('HO ST=h\nUSER=u\n'), { USER: 'u' });
});

test('a key named __proto__ lands as an own property and does not touch Object.prototype', () => {
    const out = parseEnvFile('__proto__=polluted\nHOST=h\n');
    assert.equal(out.HOST, 'h');
    assert.equal(Object.prototype.hasOwnProperty.call(out, '__proto__'), true);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

// ── dialect selection ──────────────────────────────────────────────────────────

test('the default dialect is node, and { strict: true } alone selects credential', () => {
    // The two call sites must keep working untouched: reload.ts passes nothing, and
    // datasources-dir.ts passes { strict: true }. That is the whole reason the dialect
    // default is derived from `strict`.
    assert.equal(parseEnvFile('P=p@ss #note\n').P, 'p@ss'); //           bare ⇒ node
    assert.equal(parseEnvFile('P=p@ss #note\n', { strict: true }).P, 'p@ss #note'); // ⇒ credential
});

test('dialect can be named explicitly, overriding the strict-derived default', () => {
    assert.equal(parseEnvFile('P=p@ss #note\n', { strict: true, dialect: 'node' }).P, 'p@ss');
    assert.equal(parseEnvFile('P=p@ss #note\n', { dialect: 'credential' }).P, 'p@ss #note');
});

// ── node dialect: verified against `node --env-file` on v22.21.1 ───────────────

test('SECURITY: node dialect truncates an unquoted value at # exactly as node does', () => {
    // Chain 1: `DS_MAIN_PASSWORD=p@ss # rotated` boots as `p@ss` but reloaded as the whole
    // string, so the deep-compare says "changed" and rebuilds a pool with a wrong password
    // on EVERY reload, forever. Matching node is what stops the churn.
    const out = parseEnvFile('DS_MAIN_PASSWORD=p@ss # rotated 2026-08-01\nB=p@ss#word\nC=#\nD= # c\n');
    assert.equal(out.DS_MAIN_PASSWORD, 'p@ss');
    assert.equal(out.B, 'p@ss');
    assert.equal(out.C, '');
    assert.equal(out.D, '');
});

test('node dialect treats backticks as quotes', () => {
    assert.equal(parseEnvFile('E=`tick`\n').E, 'tick');
});

test('node dialect expands \\n inside DOUBLE quotes only', () => {
    const out = parseEnvFile('A="line\\nbreak"\nB=\'line\\nbreak\'\nC=`line\\nbreak`\nD="tab\\there"\n');
    assert.equal(out.A, 'line\nbreak');
    assert.equal(out.B, 'line\\nbreak');
    assert.equal(out.C, 'line\\nbreak');
    assert.equal(out.D, 'tab\\there'); // \t is NOT an escape node understands
});

test('node dialect discards whatever follows the closing quote', () => {
    assert.equal(parseEnvFile('A="v" trailing junk\n').A, 'v');
    assert.equal(parseEnvFile('A="v" # comment\n').A, 'v');
    assert.equal(parseEnvFile('A="v" then "x"\n').A, 'v');
});

test('node dialect keeps an unterminated quote verbatim, then parses the next line', () => {
    const out = parseEnvFile('P="abc\nQ=q\n');
    assert.equal(out.P, '"abc');
    assert.equal(out.Q, 'q');
});

test('SECURITY: node dialect reads a multi-line quoted value as ONE value', () => {
    // Chain 2, the serious one: node sees a single quoted string spanning three lines, so
    // TOKEN_X_SECRET is never a variable at boot. A line-at-a-time parser promotes it to a
    // real top-level key — a credential that boot never saw going live on SIGHUP.
    const out = parseEnvFile('A=1\nD="line1\nTOKEN_X_SECRET=hunter2\nline3"\nZ=end\n');
    // The absence check comes FIRST: `assert.deepEqual` narrows `out` to the literal shape,
    // after which a typo'd key name would no longer compile as a probe of the real map.
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'TOKEN_X_SECRET'), false);
    assert.deepEqual(out, { A: '1', D: 'line1\nTOKEN_X_SECRET=hunter2\nline3', Z: 'end' });
});

test('node dialect spans multi-line values for every quote character', () => {
    assert.equal(parseEnvFile("D='a\nb'\n").D, 'a\nb');
    assert.equal(parseEnvFile('D=`a\nb`\n').D, 'a\nb');
    assert.equal(parseEnvFile('D="a\n# inner\n\nb"\nZ=end\n').D, 'a\n# inner\n\nb');
});

test('node dialect normalizes CRLF inside a multi-line value', () => {
    assert.equal(parseEnvFile('D="l1\r\nl2"\r\nZ=end\r\n').D, 'l1\nl2');
});

test('SECURITY: node dialect does NOT strip a BOM, so the first key stays undefined', () => {
    // Chain 3: node leaves the BOM attached, making the key "﻿H" — `H` is simply not
    // set at boot. Stripping it here would make `H` appear on reload only, which reads as a
    // permanent "changed" and produces a warning no edit to the file can clear.
    assert.deepEqual(parseEnvFile('﻿H=v\nZ=end\n'), { Z: 'end' });
    // A BOM in front of a comment line is harmless — node skips the line either way.
    assert.deepEqual(parseEnvFile('﻿# c\nH=v\n'), { H: 'v' });
});

// ── credential dialect: `datasources.d/*.env`, which node NEVER parses ─────────

test('SECURITY: credential dialect keeps a # inside an unquoted value', () => {
    // No node baseline exists for these files, so the safer rule wins: truncating
    // `p@ss#word` at the hash would silently authenticate with the wrong secret.
    const out = parseEnvFile('PASSWORD=p@ss#word\nOTHER=v # not a comment\n', { dialect: 'credential' });
    assert.equal(out.PASSWORD, 'p@ss#word');
    assert.equal(out.OTHER, 'v # not a comment');
});

test('credential dialect does not expand backslash escapes or treat ` as a quote', () => {
    const out = parseEnvFile('B="line\\nbreak"\nE=`tick`\n', { dialect: 'credential' });
    assert.equal(out.B, 'line\\nbreak');
    assert.equal(out.E, '`tick`');
});

test('credential dialect strips a leading BOM', () => {
    assert.deepEqual(parseEnvFile('﻿HOST=h\nUSER=u\n', { dialect: 'credential' }), { HOST: 'h', USER: 'u' });
});

test('credential dialect leaves an unbalanced quote alone when nothing closes it', () => {
    const out = parseEnvFile('PASSWORD="abc\nUSER=u\n', { dialect: 'credential' });
    assert.equal(out.PASSWORD, '"abc');
    assert.equal(out.USER, 'u');
});

test('SECURITY: credential dialect refuses a multi-line quoted value instead of mis-parsing it', () => {
    const text = 'HOST=h\nPASSWORD="line1\nDENIED_TABLES=\nline3"\nUSER=u\n';
    // strict (what datasources-dir.ts uses): fail closed, naming the line.
    assert.throws(() => parseEnvFile(text, { strict: true }), (err: Error) => {
        assert.match(err.message, /line 2/);
        return true;
    });
    // lenient: the span is consumed whole. The point is what must NOT happen — the lines
    // inside the value must never be promoted to top-level keys.
    const out = parseEnvFile(text, { dialect: 'credential' });
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'DENIED_TABLES'), false);
    assert.deepEqual(out, { HOST: 'h', USER: 'u' });
});

// ── strict mode errors: line NUMBER only, never line CONTENT ───────────────────

test('strict throws on a line with no =, naming the line number', () => {
    assert.throws(() => parseEnvFile('HOST=h\nDENIED_TABLES billing_accounts\n', { strict: true }), /line 2/);
});

test('strict throws on a key that is not a valid env identifier', () => {
    assert.throws(() => parseEnvFile('HO ST=h\n', { strict: true }), /line 1/);
    assert.throws(() => parseEnvFile('2HOST=h\n', { strict: true }), /line 1/);
});

test('SECURITY: strict errors never echo the offending line or key', () => {
    // datasources-dir.ts prefixes the path onto this message and reload.ts writes it to the
    // reload log, which is typically shipped to an aggregator. The file is mode-600 for a
    // reason; the log is not. "names only, never values" — so the operator gets the line
    // NUMBER and reads their own file.
    const cases: string[] = [
        'HOST=h\nPASSWORD "hunter2-super-secret"\n', // no `=` — the whole line is the secret
        'HOST=h\nhunter2-super-secret=x\n', //          bad key charset — the KEY is the secret
        'HOST=h\nPASSWORD="hunter2-super-secret\nMORE=x"\n', // multi-line span refusal
    ];
    for (const text of cases) {
        assert.throws(() => parseEnvFile(text, { strict: true }), (err: Error) => {
            assert.match(err.message, /line 2/);
            assert.doesNotMatch(err.message, /hunter2/);
            return true;
        });
    }
});

test('strict throws on an assignment with an empty key', () => {
    assert.throws(() => parseEnvFile('=novalue\n', { strict: true }), /line 1/);
    assert.deepEqual(parseEnvFile('=novalue\nZ=end\n'), { Z: 'end' }); // lenient: skipped, as node does
});
