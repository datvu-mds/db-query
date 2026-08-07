import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertStatementAllowed } from '../src/query/statement-guard.js';
import { BadRequestError } from '../src/query/gateway-errors.js';

const ok = (sql: string, write = false) => assert.doesNotThrow(() => assertStatementAllowed(sql, { write }));
const rejected = (sql: string, write = false) =>
    assert.throws(() => assertStatementAllowed(sql, { write }), (e) => e instanceof BadRequestError, sql);

// The exact SQL the server issues at boot (assert-readonly-posture.ts) — it MUST
// pass the guard or every boot would fail its own posture probe.
const BOOT_PROBE_SQL = `
    SELECT current_user AS db_user,
           current_setting('default_transaction_read_only') AS default_read_only,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
           CASE WHEN to_regrole('pg_write_all_data') IS NULL THEN false
                ELSE pg_has_role(current_user, to_regrole('pg_write_all_data')::oid, 'MEMBER') END AS write_all_data,
           (SELECT count(*)::int FROM pg_class c WHERE has_table_privilege(c.oid, 'INSERT')) AS writable_relations`;

// The three introspection SELECTs (introspect-service.ts).
const INTROSPECT_SQLS = [
    'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name',
    'SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
    'SELECT column_name, data_type, is_nullable, column_default, ordinal_position FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
];

test('allows read-mode statements', () => {
    ok('SELECT 1');
    ok('select 1');
    ok('  \n SELECT 1'); // leading whitespace/newline
    ok('WITH t AS (SELECT 1) SELECT * FROM t');
    ok('EXPLAIN SELECT 1');
    ok('EXPLAIN (FORMAT JSON) SELECT 1');
    ok('VALUES (1)');
    ok('TABLE pg_class');
});

// SHOW was removed from the read allowlist: it leaks server settings and exposes no
// relations for the relation guard to police. Read a setting with current_setting().
test('rejects SHOW (removed from the allowlist)', () => {
    rejected('SHOW server_version');
    rejected('SHOW all');
});

test('allows the boot-probe SQL and all introspection SQL', () => {
    ok(BOOT_PROBE_SQL);
    for (const sql of INTROSPECT_SQLS) ok(sql);
});

test('rejects the reproduction-table payloads (read mode)', () => {
    rejected("COPY (SELECT 1) TO PROGRAM 'id'"); // C-1
    rejected("COPY (SELECT 'x') TO '/tmp/f'"); // C-3
    rejected("SELECT pg_read_file('/etc/passwd')"); // C-4
    rejected('SELECT pg_terminate_backend(1)'); // M-1
    rejected("SELECT pg_logical_emit_message(false,'x','y')"); // M-2
    rejected("SELECT lo_export(1,'/tmp/f')");
    rejected("SELECT dblink('conn','SELECT 1')");
    rejected('SELECT pg_reload_conf()');
    rejected("SELECT pg_ls_dir('/')");
    rejected('SELECT pg_stat_reset()');
    rejected('CALL do_thing()');
    rejected('DO $$ BEGIN PERFORM 1; END $$');
    rejected('SET statement_timeout = 0');
    rejected('ALTER SYSTEM SET x = 1');
    rejected('CREATE TABLE t (id int)');
    rejected('TRUNCATE t');
    rejected('DROP TABLE t');
});

test('rejects the write functions even from a write token', () => {
    rejected("COPY (SELECT 1) TO PROGRAM 'id'", true);
    rejected("SELECT pg_read_file('/etc/passwd')", true);
});

test('rejects comment/qualifier/case bypass attempts', () => {
    rejected("SELECT/**/pg_read_file('x')");
    rejected("SELECT  pg_catalog.pg_read_file('x')");
    rejected("Copy (SELECT 1) To Program 'id'");
    rejected('SELECT\n  pg_terminate_backend(1)');
    rejected("SELECT pg_read_file  ('x')"); // whitespace before (
});

// C-BYPASS-1: a quoted function name resolves to the same function in Postgres, so
// blanking the quoted identifier (correct for the ;-scanner) must NOT hide it here.
test('rejects quoted-identifier function bypass', () => {
    rejected(`SELECT "pg_read_file"('/etc/passwd', 0, 200)`);
    rejected(`SELECT pg_catalog."pg_read_file"('/etc/passwd')`);
    rejected(`SELECT "pg_terminate_backend"(1)`);
    rejected(`SELECT "dblink"('conn','SELECT 1')`);
    rejected(`SELECT "pg_logical_emit_message"(false,'x','y')`);
    rejected(`SELECT * FROM "pg_ls_dir"('/')`);
    rejected(`SELECT U&"pg_read_file"('/etc/passwd')`); // unicode prefix, no escapes
    rejected(`SELECT "pg_read_file" ('x')`); // space between quoted name and (
});

test('quoted identifiers that are not calls stay allowed (no false positive)', () => {
    ok('SELECT "pg_read_file" FROM t'); // column named like a banned fn, no ()
    ok('SELECT "dblink" AS d FROM t');
    ok('SELECT id FROM "pg_terminate_backend"'); // table named like a banned fn
});

test('does not false-positive on banned names inside string literals or as bare identifiers', () => {
    ok("SELECT 'pg_read_file(' AS note");
    ok("SELECT 'COPY' AS k");
    ok('SELECT dblink FROM t'); // column/alias named dblink, no call
    ok("SELECT 'DROP TABLE t' AS sql_text");
});

test('write mode allows data-modifying statements that read mode rejects', () => {
    ok('INSERT INTO t VALUES (1)', true);
    ok('UPDATE t SET a = 1', true);
    ok('DELETE FROM t WHERE id = 1', true);
    ok('MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', true);

    rejected('INSERT INTO t VALUES (1)'); // same SQL, read mode
    rejected('UPDATE t SET a = 1');
    rejected('DELETE FROM t WHERE id = 1');
});

test('error message is actionable (names the escape hatch)', () => {
    try {
        assertStatementAllowed("COPY (SELECT 1) TO PROGRAM 'id'", { write: false });
        assert.fail('should have thrown');
    } catch (e) {
        assert.match((e as Error).message, /ALLOW_UNSAFE_STATEMENTS/);
    }
});
