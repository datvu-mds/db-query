/**
 * SECURITY regression: datasource credential files must not be committable.
 *
 * This is a shipping deliverable, not repo hygiene. The pre-existing `.env` /
 * `.env.*` patterns match on BASENAME, and `warehouse.env` starts with neither — so
 * before this feature added its rule, `datasources.d/warehouse.env` (a file whose
 * entire purpose is to hold a database password) was tracked by default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `git check-ignore` exits 0 when the path IS ignored, 1 when it is not. */
function isIgnored(relPath: string): boolean {
    try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', relPath], { cwd: repoRoot });
        return true;
    } catch {
        return false;
    }
}

test('SECURITY: a datasource credential file is git-ignored', () => {
    assert.equal(isIgnored('datasources.d/warehouse.env'), true);
    // Any name, not just the one in the docs — the operator picks these freely.
    assert.equal(isIgnored('datasources.d/prod-replica.env'), true);
});

test('the in-directory template is TRACKABLE — the negation actually works', () => {
    // `datasources.d/*` rather than `datasources.d/` is what makes this possible:
    // git cannot re-include a file whose PARENT DIRECTORY is excluded, so the
    // directory form would silently swallow this negation and the template with it.
    assert.equal(isIgnored('datasources.d/example.env.disabled'), false);
    assert.ok(existsSync(resolve(repoRoot, 'datasources.d/example.env.disabled')), 'template file should exist');

    // ...and prove it for real rather than by absence. `isIgnored` passes `--no-index`,
    // which by design DISREGARDS the index — so on its own it can say "not ignored" but
    // can never distinguish tracked from untracked. `git add --dry-run` fails on a path
    // the ignore rules exclude, so a clean exit is positive evidence the file can enter
    // the index. (Asserting it IS tracked would fail on this branch for a reason that has
    // nothing to do with the ignore rules: the whole branch is still uncommitted.)
    execFileSync('git', ['add', '--dry-run', 'datasources.d/example.env.disabled'], { cwd: repoRoot });

    // The inverse must fail — and it must fail for the RIGHT reason. The file has to
    // exist first: `git add` on a missing path fails with "pathspec did not match",
    // which would make this assertion pass while proving nothing about ignore rules.
    const decoy = resolve(repoRoot, 'datasources.d/__ignore_probe.env');
    writeFileSync(decoy, 'HOST=probe\n');
    try {
        let stderr = '';
        assert.throws(
            () => {
                try {
                    execFileSync('git', ['add', '--dry-run', 'datasources.d/__ignore_probe.env'], { cwd: repoRoot, stdio: 'pipe' });
                } catch (err) {
                    stderr = String((err as { stderr?: Buffer }).stderr ?? '');
                    throw err;
                }
            },
            'a credential file must be refused by git add',
        );
        assert.match(stderr, /ignored/i, 'must be refused because it is IGNORED, not because the path is missing');
    } finally {
        rmSync(decoy, { force: true });
    }
});
