import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionInfoFunction, sensitiveSettingArg, CONNECTION_INFO_FUNCTIONS, SQL_VALUE_FUNCTION_NAMES } from '../src/query/connection-info-functions.js';

test('connectionInfoFunction flags identity/location functions (case-insensitive)', () => {
    for (const name of [
        'current_user',
        'session_user',
        'current_role',
        'user',
        'current_database',
        'current_catalog',
        'current_schema',
        'current_schemas',
        'inet_server_addr',
        'inet_server_port',
        'inet_client_addr',
        'inet_client_port',
        'CURRENT_USER',
        'Current_Database',
    ]) {
        assert.equal(connectionInfoFunction(name), name, `expected blocked: ${name}`);
    }
});

test('connectionInfoFunction does NOT flag ordinary/date-time functions', () => {
    for (const name of ['now', 'current_date', 'current_time', 'current_timestamp', 'localtime', 'count', 'max', 'coalesce', 'user_name']) {
        assert.equal(connectionInfoFunction(name), null, `expected allowed: ${name}`);
    }
});

test('every SQLValueFunction op maps to a name that is itself on the denylist', () => {
    // Guards against the two lists drifting: a mapped keyword op that the name denylist
    // does not also cover would be collected but never blocked.
    for (const name of Object.values(SQL_VALUE_FUNCTION_NAMES)) {
        assert.ok(CONNECTION_INFO_FUNCTIONS.includes(name), `${name} mapped but not on denylist`);
    }
});

test('sensitiveSettingArg: identity GUCs and unknown (null) args are sensitive; others are not', () => {
    assert.equal(sensitiveSettingArg('session_authorization'), true);
    assert.equal(sensitiveSettingArg('role'), true);
    assert.equal(sensitiveSettingArg('SESSION_AUTHORIZATION'), true); // case-insensitive
    assert.equal(sensitiveSettingArg(null), true); // fail-closed on non-literal
    assert.equal(sensitiveSettingArg('statement_timeout'), false);
    assert.equal(sensitiveSettingArg('search_path'), false);
});
