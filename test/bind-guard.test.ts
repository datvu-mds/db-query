import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { assertBindAllowed, isSafeBindHost } from '../src/config/bind-guard.js';

afterEach(() => {
    delete process.env.ALLOW_PUBLIC_BIND;
});

test('loopback hosts bind without objection', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '127.1.2.3', 'localhost', 'LocalHost', '::1', '[::1]', ' 127.0.0.1 ']) {
        assert.doesNotThrow(() => assertBindAllowed(host, 'HTTP gateway'), host);
    }
});

test('wildcard hosts are refused', () => {
    for (const host of ['0.0.0.0', '::', '[::]', '*', ' 0.0.0.0 ']) {
        assert.throws(() => assertBindAllowed(host, 'HTTP gateway'), /Refusing to start HTTP gateway/, host);
    }
});

// Regression: these all make Node bind EVERY interface but slipped through the
// original wildcard denylist. The guard is an allowlist precisely so that
// enumerating these forms is not required for correctness.
test('sneaky wildcard spellings that Node resolves to every interface are refused', () => {
    for (const host of ['', '   ', '0', '0.0', '::0', '0:0:0:0:0:0:0:0', '[::0]', '0x0', '::ffff:0.0.0.0']) {
        assert.throws(() => assertBindAllowed(host, 'HTTP gateway'), /Refusing to start/, JSON.stringify(host));
    }
});

test('a non-loopback address needs the flag even when it is private', () => {
    for (const host of ['10.0.0.5', '192.168.1.10', 'db.internal']) {
        assert.throws(() => assertBindAllowed(host, 'HTTP gateway'), /Refusing to start/, host);
    }
});

test('the empty host is described legibly rather than as blank', () => {
    assert.throws(() => assertBindAllowed('', 'HTTP gateway'), /on <empty>/);
});

test('the error names the transport and both escape routes', () => {
    assert.throws(() => assertBindAllowed('0.0.0.0', 'MCP streamable-HTTP transport'), (err: Error) => {
        assert.match(err.message, /MCP streamable-HTTP transport/);
        assert.match(err.message, /HOST=127\.0\.0\.1/);
        assert.match(err.message, /ALLOW_PUBLIC_BIND=true/);
        return true;
    });
});

test('ALLOW_PUBLIC_BIND=true makes a non-loopback bind a deliberate opt-in', () => {
    process.env.ALLOW_PUBLIC_BIND = 'true';
    for (const host of ['0.0.0.0', '', '10.0.0.5']) {
        assert.doesNotThrow(() => assertBindAllowed(host, 'HTTP gateway'), JSON.stringify(host));
    }
});

test('only the exact string "true" opts in — no loose truthiness', () => {
    for (const value of ['1', 'yes', 'TRUE', 'false', '']) {
        process.env.ALLOW_PUBLIC_BIND = value;
        assert.throws(() => assertBindAllowed('0.0.0.0', 'HTTP gateway'), /Refusing to start/, `ALLOW_PUBLIC_BIND=${value}`);
    }
});

test('isSafeBindHost classifies hosts independently of the env flag', () => {
    process.env.ALLOW_PUBLIC_BIND = 'true';
    assert.equal(isSafeBindHost('0.0.0.0'), false);
    assert.equal(isSafeBindHost('127.0.0.1'), true);
});

// Ties the allowlist to observable reality: anything the guard accepts must actually
// bind a loopback address. This is what makes the rule verifiable rather than asserted.
test('every host the guard accepts genuinely binds loopback only', async () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
        const address = await new Promise<string>((resolve, reject) => {
            const s = net.createServer();
            s.on('error', reject);
            s.listen(0, host, () => {
                const addr = s.address();
                const value = typeof addr === 'object' && addr ? addr.address : String(addr);
                s.close(() => resolve(value));
            });
        });
        assert.ok(address === '127.0.0.1' || address === '::1', `${host} bound ${address}, expected loopback`);
    }
});
