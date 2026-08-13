/**
 * datasources-dir — read `datasources.d/<name>.env` into env-shaped keys.
 *
 * A datasource file is hand-authored (there is deliberately no CLI and no agent-reachable
 * surface that accepts a credential), so it uses BARE keys and takes its identity from the
 * filename:
 *
 *     datasources.d/warehouse.env   (mode 600)      →  datasource "warehouse"
 *     HOST=warehouse.internal                       →  DS_WAREHOUSE_HOST=warehouse.internal
 *
 * That rewrite is the whole job. There is no second config model here: the normalized keys
 * are handed to the EXISTING `buildDatasource()` + `datasourceSchema`, so every zod
 * default, the `bool()` / `boolSecureDefault()` asymmetry, and every guard default are
 * reused unchanged. A parallel model is how the two paths would come to disagree about
 * what `SENSITIVE_RELATION_DENYLIST=maybe` means.
 *
 * CONTRACT FOR THE CALLER (reload.ts / boot):
 *   - `source` contains ONLY `DS_<NAME>_*` keys. It deliberately does NOT contain
 *     `DATASOURCES`: the merged map is built as `{...process.env, ...dotenv, ...source}`,
 *     so a `DATASOURCES` key here would OVERWRITE the `.env` id list and silently unload
 *     every `.env` datasource. The caller must UNION `names` into `DATASOURCES` itself.
 *   - `names` is otherwise informational: it names what this directory contributed, and
 *     lets the caller report or diff it. It NO LONGER carries a per-source `writable`
 *     default — `writable` fails closed from every config source now, so a datasource
 *     dropped in here lands read-only without the caller having to say anything. That
 *     single unconditional default replaced a per-source parameter precisely because a
 *     parameter is a call site that can be got wrong, and getting it wrong failed OPEN.
 *
 * Everything in here fails CLOSED: a bad mode, an unknown key, an unparseable line or a
 * bad filename throws, and reload stage 1 turns that into "nothing changed". A datasource
 * file is a credential; the failure mode of guessing is a password in the wrong place.
 */
import fs from 'node:fs';
import path from 'node:path';
import { datasourceSchema } from './config.schema.js';
import type { ConfigSource } from './load-config.js';
import { parseEnvFile } from './env-file.js';

/** Default directory, resolved CWD-relative — mirroring how `--env-file-if-exists=.env` already finds `.env`. */
const DEFAULT_DIR = 'datasources.d';

/** Only this extension is read, so `example.env.disabled` is a template that lives IN the directory without being loaded. */
const EXT = '.env';

/** The filename stem becomes a datasource name, so it is held to the same shape a name may take. */
const NAME_RE = /^[a-z0-9_-]+$/;

/** camelCase schema field → the SCREAMING_SNAKE suffix load-config reads after `DS_<NAME>_`. */
function toEnvKey(field: string): string {
    return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/**
 * The bare keys a datasource file may set — DERIVED from `datasourceSchema` rather than
 * listed by hand, so this allowlist cannot drift away from the schema it guards. A field
 * added to the schema becomes settable from a file automatically, and the tripwire test in
 * `test/datasources-dir.test.ts` fails loudly if a new field's key does not follow the
 * camelCase→SCREAMING_SNAKE convention that `buildDatasource()` assumes.
 *
 * `name` is excluded: identity comes from the filename, and letting a file rename itself
 * would break the one-file-one-datasource mapping the collision check depends on.
 */
export const DATASOURCE_FILE_KEYS: ReadonlySet<string> = new Set(
    Object.keys(datasourceSchema.shape)
        .filter((field) => field !== 'name')
        .map(toEnvKey),
);

export interface DatasourcesDirResult {
    /** Normalized `DS_<NAME>_*` keys, ready to be spread into a merged source map. Never contains `DATASOURCES`. */
    source: ConfigSource;
    /** Datasource names contributed by this directory, in filename order. */
    names: string[];
    /** name → absolute file path. Lets the caller name the offending FILE when a name collides with `.env`. */
    files: Record<string, string>;
    /** The absolute directory that was read — reported even when it does not exist, so a log can show where we looked. */
    dir: string;
}

/** Resolve the datasource directory: `DATASOURCES_DIR` if set, else CWD-relative `./datasources.d`. */
export function resolveDatasourcesDir(source: ConfigSource = process.env): string {
    const configured = source.DATASOURCES_DIR?.trim();
    return path.resolve(process.cwd(), configured || DEFAULT_DIR);
}

/**
 * True when a file's permission bits are `600` or stricter — i.e. no group and no other
 * access at all.
 *
 * Accepts a raw `statSync().mode`, whose high bits are the file type (`0o100644`), so the
 * caller never has to remember to mask. Exported separately from the file read so the
 * permission rule can be asserted against a given mode regardless of the uid the test
 * suite runs as (a root CI run can read a 000 file and would otherwise "pass" without the
 * rule ever being exercised).
 *
 * Note for Windows: `statSync().mode` there is approximately `0o666` for every file, so
 * this refuses everything. That is a documented platform limitation of the whole reload
 * feature (SIGHUP is undeliverable there too), not an accident of this check.
 */
export function isSecureMode(mode: number): boolean {
    return (mode & 0o077) === 0;
}

/** Throw an operator-actionable error unless the mode is `600`-or-stricter. */
export function assertSecureMode(mode: number, file: string): void {
    if (isSecureMode(mode)) return;
    // Print the permission bits only: the raw stat mode reads as "100644" and would tell
    // the operator to fix a mode that does not exist.
    const perms = (mode & 0o777).toString(8).padStart(3, '0');
    throw new Error(
        `${file} is mode ${perms} — a datasource file holds a database password and must not be readable by group or others. Fix: chmod 600 ${file}`,
    );
}

/**
 * Filename → datasource name. Lowercased, then held to `/^[a-z0-9_-]+$/`.
 *
 * Rejecting rather than sanitizing is deliberate: a name that silently differs from the
 * filename would not match the `TOKEN_*_DATASOURCES` grant the operator wrote, and the
 * symptom (403, or a datasource that is simply not there) would point nowhere near the
 * cause. A dot is excluded too, so `warehouse.env.bak` cannot masquerade as a datasource.
 */
export function datasourceNameFromFile(filename: string): string {
    const name = path.basename(filename, EXT).toLowerCase();
    if (!NAME_RE.test(name)) {
        throw new Error(
            `invalid datasource file name "${filename}": the part before ${EXT} becomes the datasource name and must match ${String(NAME_RE)} (lowercase letters, digits, underscore, hyphen)`,
        );
    }
    return name;
}

/** Directory listing of `*.env` regular files, sorted for determinism. Missing directory ⇒ []. */
function listEnvFiles(dir: string): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        // A missing directory is NOT an error: the feature is opt-in and every
        // pre-existing deployment must keep booting without creating anything. Any other
        // failure (ENOTDIR, EACCES) is real and must surface — silently treating an
        // unreadable directory as empty would drop datasources without a word.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
    }
    return entries
        // Subdirectories and sockets named `*.env` are not config; symlinks are NOT
        // excluded here because the stat below follows them, which is what we want — the
        // mode that matters is the target's (a symlink's own mode is always 0o777).
        .filter((e) => !e.isDirectory() && e.name.endsWith(EXT))
        .map((e) => e.name)
        .sort();
}

/**
 * Read every `datasources.d/*.env`, verify its mode, and return normalized `DS_<NAME>_*`
 * keys. Throws on the first problem; the caller (reload stage 1) treats that as
 * "nothing changed".
 */
export function readDatasourcesDir(dir: string = resolveDatasourcesDir()): DatasourcesDirResult {
    const source: ConfigSource = {};
    const names: string[] = [];
    const files: Record<string, string> = {};
    // A Map, NOT a plain object keyed by name: `constructor` and `__proto__` both satisfy
    // NAME_RE, and probing a plain object for them returns an INHERITED value — so
    // `constructor.env` would be rejected as a duplicate of a file that does not exist.
    const seen = new Map<string, string>();

    for (const filename of listEnvFiles(dir)) {
        const file = path.join(dir, filename);

        const stat = fs.statSync(file); // follows symlinks: check the credential's real mode
        if (!stat.isFile()) continue;
        assertSecureMode(stat.mode, file);

        const name = datasourceNameFromFile(filename);
        const prior = seen.get(name);
        if (prior !== undefined) {
            // Reachable on a case-sensitive filesystem via `warehouse.env` + `Warehouse.env`.
            // Two files claiming one name means one of them is silently ignored — and the
            // ignored one could be the read-only definition.
            throw new Error(`datasource "${name}" is defined twice: ${prior} and ${file}`);
        }

        // strict: unlike `.env` (parsed by `node --env-file` at boot, which skips what it
        // cannot read — see env-file.ts), nothing else ever parses these files, so a
        // malformed line must be loud. `DENIED_TABLES billing_accounts` with a missing `=`
        // produces no key at all, and the unknown-key check below would never see it.
        let parsed: Record<string, string>;
        try {
            parsed = parseEnvFile(fs.readFileSync(file, 'utf8'), { strict: true });
        } catch (err) {
            throw new Error(`${file}: ${(err as Error).message}`);
        }

        const prefix = `DS_${name.toUpperCase()}_`;
        for (const [key, value] of Object.entries(parsed)) {
            if (!DATASOURCE_FILE_KEYS.has(key)) {
                // Fail closed on anything that is not a datasource field. This is the check
                // that stops a `TOKENS=` / `TOKEN_X_DATASOURCES=*` line in a datasource file
                // from widening someone's grants: `.env` remains the only home for tokens,
                // ports and process settings. It also catches an already-prefixed
                // `DS_MAIN_PASSWORD=` trying to redefine a DIFFERENT datasource from inside
                // this one's file.
                throw new Error(
                    `${file}: unknown key "${key}". A datasource file may only set datasource fields (${[...DATASOURCE_FILE_KEYS].sort().join(', ')}); tokens, ports and other process settings belong in .env.`,
                );
            }
            source[prefix + key] = value;
        }

        names.push(name);
        seen.set(name, file);
        files[name] = file;
    }

    return { source, names, files, dir };
}
