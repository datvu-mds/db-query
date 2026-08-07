import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripToCode } from '../src/query/sql-lexer.js';

// The whole point of the lexer is a same-length "code-only" view: offsets stay
// stable so downstream regex/indexOf checks are trivial. If length ever drifts,
// every offset-based consumer is silently wrong.
test('length invariant: output length always equals input length', () => {
    const inputs = [
        '',
        'SELECT 1',
        "SELECT 'a; b' AS x",
        'SELECT 1 -- trailing comment',
        'SELECT 1 /* block */ , 2',
        "SELECT E'a\\'b'",
        'SELECT $tag$ body; with ; $tag$',
        'SELECT "weird ; ident"',
        '/* unterminated block comment',
        "SELECT 'unterminated string",
        '$$ unterminated dollar',
    ];
    for (const s of inputs) {
        assert.equal(stripToCode(s).length, s.length, `length mismatch for: ${JSON.stringify(s)}`);
    }
});

test('blanks line comments, keeping surrounding code', () => {
    assert.equal(stripToCode('SELECT 1 -- a; b\nFROM t'), 'SELECT 1        \nFROM t');
});

test('blanks block comments, keeping surrounding code', () => {
    const sql = 'SELECT /*;*/ 1';
    const out = stripToCode(sql);
    assert.equal(out.length, sql.length);
    assert.equal(out.replace(/\s+/g, ' '), 'SELECT 1'); // comment gone, code intact
    assert.ok(!out.includes(';'));
});

test('blanks single-quoted strings (with the top-level ; still visible after)', () => {
    // Success-criterion case from the plan: string + comment blanked, top-level ; + x kept.
    const out = stripToCode("SELECT 'a;b' /*;*/ ; x");
    assert.equal(out.length, "SELECT 'a;b' /*;*/ ; x".length);
    // The two `;` inside the string/comment are gone; the top-level one remains.
    assert.equal(out.replace(/\s+/g, ''), 'SELECT;x');
});

test('blanks E-strings including the escaped-quote body', () => {
    // `\'` does NOT terminate an E-string, so the whole body must be blanked.
    const out = stripToCode("SELECT E'a\\'b' AS c");
    assert.ok(!out.includes('a'), 'E-string body should be blanked');
    assert.ok(out.includes('SELECT') && out.includes('AS c'));
});

test('blanks double-quoted identifiers', () => {
    const out = stripToCode('SELECT 1 AS "we;ird"');
    assert.ok(!out.includes(';'), 'semicolon inside quoted ident must be blanked');
});

test('blanks dollar-quoted bodies', () => {
    const out = stripToCode('SELECT $tag$ a; b; c $tag$ FROM t');
    assert.ok(!out.includes(';'), 'semicolons inside dollar body must be blanked');
    assert.ok(out.includes('SELECT') && out.includes('FROM t'));
});

// Regression anchor mirroring single-statement.ts's load-bearing E-string case:
// the top-level `;` after the E-string must survive blanking (so the multi-statement
// scan can still see it), while the ; inside the E-string does not.
test('regression: E-string escaped quote does not hide the following top-level ;', () => {
    const out = stripToCode("SELECT E'\\'; still-inside'; DROP TABLE t");
    const semis = [...out].map((c, i) => (c === ';' ? i : -1)).filter((i) => i >= 0);
    // Exactly one visible ; — the top-level separator, not the one inside the E-string.
    assert.equal(semis.length, 1);
    assert.ok(out.slice(semis[0] + 1).includes('DROP TABLE t'));
});

test('code characters outside any span are preserved verbatim', () => {
    const sql = 'WITH t AS (SELECT 1) SELECT * FROM t';
    // No strings/comments → identical output.
    assert.equal(stripToCode(sql), sql);
});

test('revealQuotedIdents keeps identifier text but blanks the quote chars', () => {
    const sql = 'SELECT "pg_read_file"(1)';
    const revealed = stripToCode(sql, { revealQuotedIdents: true });
    assert.equal(revealed.length, sql.length); // still same-length
    assert.ok(revealed.includes('pg_read_file'), 'quoted ident content must survive');
    assert.ok(!revealed.includes('"'), 'quote delimiters must be blanked');
    // Default mode still blanks the whole quoted identifier.
    assert.ok(!stripToCode(sql).includes('pg_read_file'));
});

test('revealQuotedIdents still blanks strings and comments (only idents are revealed)', () => {
    const sql = `SELECT 'pg_read_file(' /* x */ , "col"`;
    const revealed = stripToCode(sql, { revealQuotedIdents: true });
    assert.ok(!revealed.includes('pg_read_file('), 'string literal stays blanked');
    assert.ok(revealed.includes('col'), 'quoted ident revealed');
});
