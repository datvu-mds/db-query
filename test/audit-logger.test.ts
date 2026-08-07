import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { AuditLogger } from '../src/audit/audit-logger.js';

function capture(): { logger: pino.Logger; lines: Record<string, unknown>[] } {
    const lines: Record<string, unknown>[] = [];
    const stream = { write: (s: string) => lines.push(JSON.parse(s)) };
    return { logger: pino({ level: 'info' }, stream), lines };
}

test('emits all base fields for a successful query', () => {
    const { logger, lines } = capture();
    new AuditLogger(logger).logQuery({ tokenId: 't', datasource: 'd', schema: 's', sql: 'SELECT 1', rowCount: 2, elapsedMs: 5 });
    assert.equal(lines.length, 1);
    const l = lines[0];
    assert.equal(l.tokenId, 't');
    assert.equal(l.datasource, 'd');
    assert.equal(l.schema, 's');
    assert.equal(l.sql, 'SELECT 1');
    assert.equal(l.rowCount, 2);
    assert.equal(l.elapsedMs, 5);
    assert.equal(l.msg, 'query ok');
});

test('error path logs at warn level with the error field', () => {
    const { logger, lines } = capture();
    new AuditLogger(logger).logQuery({ tokenId: 't', datasource: 'd', schema: 's', sql: 'x', rowCount: 0, elapsedMs: 1, error: 'nope' });
    assert.equal(lines[0].level, 40); // pino warn
    assert.equal(lines[0].error, 'nope');
    assert.equal(lines[0].msg, 'query failed');
});

test('sql at or under the cap is logged unchanged', () => {
    const { logger, lines } = capture();
    const sql = `SELECT ${'x'.repeat(1990)}`; // 1997 chars — under the 2000 cap
    new AuditLogger(logger).logQuery({ tokenId: 't', datasource: 'd', schema: 's', sql, rowCount: 0, elapsedMs: 1 });
    assert.equal(lines[0].sql, sql);
});

test('over-cap sql is truncated with a marker showing the dropped count', () => {
    const { logger, lines } = capture();
    const sql = 'a'.repeat(2500);
    const entry = { tokenId: 't', datasource: 'd', schema: 's', sql, rowCount: 0, elapsedMs: 1 };
    new AuditLogger(logger).logQuery(entry);
    assert.equal(lines[0].sql, `${'a'.repeat(2000)}…[+500 chars]`);
    // A truncated line must stay attributable: without the true length, pushing the
    // meaningful clause past the cap would silently erase it from the audit trail.
    assert.equal(lines[0].sqlLength, 2500);
    // The caller's entry must not be mutated by logging.
    assert.equal(entry.sql.length, 2500);
    assert.equal('sqlLength' in entry, false);
});

test('sqlLength is absent when nothing was truncated', () => {
    const { logger, lines } = capture();
    new AuditLogger(logger).logQuery({ tokenId: 't', datasource: 'd', schema: 's', sql: 'SELECT 1', rowCount: 0, elapsedMs: 1 });
    assert.equal(lines[0].sqlLength, undefined);
});

test('an over-cap error is truncated too — PG echoes literals into error text', () => {
    const { logger, lines } = capture();
    const error = 'e'.repeat(3000);
    new AuditLogger(logger).logQuery({ tokenId: 't', datasource: 'd', schema: 's', sql: 'SELECT 1', rowCount: 0, elapsedMs: 1, error });
    assert.equal(lines[0].error, `${'e'.repeat(2000)}…[+1000 chars]`);
    assert.equal(lines[0].sql, 'SELECT 1'); // short sql left alone
    assert.equal(lines[0].level, 40);
});

test('write path includes write/command/rowsAffected', () => {
    const { logger, lines } = capture();
    new AuditLogger(logger).logQuery({
        tokenId: 't',
        datasource: 'd',
        schema: 's',
        sql: 'INSERT',
        rowCount: 0,
        elapsedMs: 1,
        write: true,
        command: 'INSERT',
        rowsAffected: 4,
    });
    assert.equal(lines[0].write, true);
    assert.equal(lines[0].command, 'INSERT');
    assert.equal(lines[0].rowsAffected, 4);
});
