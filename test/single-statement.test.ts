import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSingleStatement } from '../src/query/single-statement.js';

test('accepts a plain single statement', () => {
    assert.doesNotThrow(() => assertSingleStatement('SELECT 1'));
});

test('accepts a single statement with a trailing semicolon', () => {
    assert.doesNotThrow(() => assertSingleStatement('SELECT 1;'));
    assert.doesNotThrow(() => assertSingleStatement('SELECT 1;   \n  '));
});

test('rejects two statements', () => {
    assert.throws(() => assertSingleStatement('SELECT 1; SELECT 2'), /Multiple SQL statements/);
    assert.throws(() => assertSingleStatement('DELETE FROM t; DROP TABLE t'), /Multiple SQL statements/);
});

test('ignores semicolons inside single-quoted string literals', () => {
    assert.doesNotThrow(() => assertSingleStatement("SELECT 'a; b' AS x"));
    assert.doesNotThrow(() => assertSingleStatement("SELECT 'it''s; fine'"));
});

test('ignores semicolons inside double-quoted identifiers', () => {
    assert.doesNotThrow(() => assertSingleStatement('SELECT 1 AS "weird;name"'));
});

test('ignores semicolons inside comments', () => {
    assert.doesNotThrow(() => assertSingleStatement('SELECT 1 -- a; b\n'));
    assert.doesNotThrow(() => assertSingleStatement('SELECT 1 /* a; b */'));
});

test('ignores semicolons inside dollar-quoted bodies', () => {
    assert.doesNotThrow(() => assertSingleStatement('SELECT $$a; b$$'));
    assert.doesNotThrow(() => assertSingleStatement('SELECT $tag$a; b; c$tag$'));
});

test('still catches a real second statement after a string literal', () => {
    assert.throws(() => assertSingleStatement("SELECT 'x'; DROP TABLE t"), /Multiple SQL statements/);
});

// Regression — E'…' escape strings. `\'` is an escaped quote, so a scanner that only
// knows the `''` form thinks the literal is still open and swallows the rest of the
// input, smuggling a second statement (e.g. a COMMIT that escapes the read-only txn).
test('catches statements smuggled behind an E-string escaped quote', () => {
    assert.throws(() => assertSingleStatement("SELECT E'\\''; DROP TABLE t"), /Multiple SQL statements/);
    assert.throws(() => assertSingleStatement("SELECT e'\\''; DROP TABLE t"), /Multiple SQL statements/);
    assert.throws(() => assertSingleStatement("SELECT E'a\\'b'; DROP TABLE t"), /Multiple SQL statements/);
    assert.throws(() => assertSingleStatement("SELECT E'\\''; COMMIT"), /Multiple SQL statements/);
    // Escaped backslash ends the literal, so the `;` after it is top-level.
    assert.throws(() => assertSingleStatement("SELECT E'\\\\'; DROP TABLE t"), /Multiple SQL statements/);
});

test('still ignores semicolons genuinely inside an E-string', () => {
    assert.doesNotThrow(() => assertSingleStatement("SELECT E'a; b'"));
    assert.doesNotThrow(() => assertSingleStatement("SELECT E'it\\'s; fine'"));
    assert.doesNotThrow(() => assertSingleStatement("SELECT E'it''s; fine'"));
});

test('a trailing `e` on an identifier is not an E-string prefix', () => {
    // standard_conforming_strings=on: the backslash here is literal and the quote
    // after it DOES close the string, so the `;` is top-level.
    assert.throws(() => assertSingleStatement("SELECT value'\\'; DROP TABLE t"), /Multiple SQL statements/);
    assert.doesNotThrow(() => assertSingleStatement("SELECT value'a; b'"));
});

test('backslash is literal (not an escape) in a standard string', () => {
    assert.throws(() => assertSingleStatement("SELECT 'a\\'; DROP TABLE t"), /Multiple SQL statements/);
});
