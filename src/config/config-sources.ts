/**
 * config-sources — gather EVERY config source into one env-shaped map.
 *
 * This module exists because boot and reload were reading different worlds. Reload read
 * `.env` + `datasources.d/`; boot called `loadConfig()` on `process.env` alone and never
 * looked at the directory at all. A datasource defined only by a file therefore existed
 * *only* after a SIGHUP and *only* for that process lifetime — it silently vanished on
 * the next restart, or, if a token named it explicitly, took the whole boot down with
 * `Token "X" references unknown datasource "warehouse"`, an error pointing at the token
 * rather than at the directory nobody read.
 *
 * That was the strongest possible violation of the rule the design calls Design Decision
 * 6: boot and reload share ONE rule set, because the alternative is that the same files
 * mean different things depending on how the process started. Both paths now come
 * through here, so the rule is enforced by construction instead of by intent.
 *
 * Ordering within the merge, lowest precedence first:
 *   process env  →  .env  →  DATABASE_* fallback (only when nothing else defines one)
 *                →  datasources.d/*.env
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnvFile } from './env-file.js';
import { readDatasourcesDir, resolveDatasourcesDir, type DatasourcesDirResult } from './datasources-dir.js';
import { fallbackAsDsKeys, list, loadConfig, type ConfigSource } from './load-config.js';
import type { RootConfig } from './config.schema.js';

export interface GatherOptions {
    /** Path to `.env`. Defaults to CWD-relative `./.env`, mirroring `--env-file-if-exists=.env`. */
    envPath?: string;
    /** Datasource directory. Defaults to `DATASOURCES_DIR` or CWD-relative `./datasources.d`. */
    datasourcesDir?: string;
    /**
     * Base environment, lowest precedence. Defaults to `process.env`. Injectable so a
     * candidate config can be assembled without mutating the live process environment —
     * a rejected reload must leave nothing behind.
     */
    baseEnv?: ConfigSource;
}

export interface GatheredSources {
    /** The merged map, ready for `loadConfig()`. */
    merged: ConfigSource;
    /** Datasource names contributed by `datasources.d/`. */
    dirNames: string[];
    /** name → absolute file path, so a caller can name the offending FILE. */
    dirFiles: Record<string, string>;
    /** The directory that was read — reported even when absent, so a log can say where we looked. */
    dir: string;
}

/** Read and parse `.env` if present. A missing `.env` is NOT an error — the process may be
 *  configured entirely from the real environment. */
function readEnvFile(envPath: string): Record<string, string> {
    let text: string;
    try {
        text = readFileSync(envPath, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw err;
    }
    // Parsed in the mode that matches `node --env-file`, which is what parsed this same
    // file at boot. Any divergence here would mean boot and reload disagree about a file
    // neither of them owns — see env-file.ts for which rules are shared and which differ.
    return parseEnvFile(text);
}

/**
 * Gather all config sources into one map. THROWS on any file-level problem (bad mode,
 * bad filename, unknown key, duplicate name, cross-source collision) — the caller decides
 * what that means: boot fails fast, reload refuses and changes nothing.
 */
export function gatherConfigSources(opts: GatherOptions = {}): GatheredSources {
    const baseEnv = opts.baseEnv ?? process.env;
    const envPath = opts.envPath ?? path.resolve(process.cwd(), '.env');

    const envFile = readEnvFile(envPath);
    const dir: DatasourcesDirResult = readDatasourcesDir(opts.datasourcesDir ?? resolveDatasourcesDir(baseEnv));

    const envSide: ConfigSource = { ...baseEnv, ...envFile };
    let envNames = list(envSide.DATASOURCES);

    // Preserve the `DATABASE_*` fallback across the merge.
    //
    // `loadConfig` seeds `main` from `DATABASE_*` ONLY when `DATASOURCES` is empty — but we
    // must set `DATASOURCES` explicitly here to introduce the directory's names, and doing
    // so is exactly what suppresses the fallback. Left unhandled, a zero-config deployment
    // (only `DATABASE_*` set) that dropped in its FIRST datasource file would silently LOSE
    // its primary datasource: `added:['warehouse'], removed:['main']`. The operator adds a
    // datasource and loses the one they had.
    //
    // Materializing the fallback as `DS_MAIN_*` keys keeps one code path in `loadConfig`
    // and makes the fallback survive contact with the directory.
    let fallbackKeys: ConfigSource = {};
    if (envNames.length === 0) {
        const fb = fallbackAsDsKeys(envSide);
        if (fb) {
            fallbackKeys = fb;
            envNames = ['main'];
        }
    }

    // Cross-source name collision, checked BEFORE the merge and CASE-INSENSITIVELY.
    //
    // Before the merge, because afterwards the directory's `DS_<NAME>_*` keys have already
    // overwritten `.env`'s and the collision is invisible — which is the silent credential
    // override this check exists to prevent.
    //
    // Case-insensitively, because `buildDatasource` derives its key prefix with
    // `name.toUpperCase()`, so the `DS_<NAME>_*` namespace is case-INsensitive while a
    // verbatim comparison is case-sensitive. `DATASOURCES=…,Warehouse` plus
    // `datasources.d/warehouse.env` slipped straight through and produced a per-key HYBRID:
    // `deniedTables` from `.env`, `host`/`password`/`writable`/`allowUnsafeStatements` from
    // the file — silently turning a read-only datasource writable with its guards off.
    const byLower = new Map<string, string>();
    for (const name of envNames) {
        const lower = name.toLowerCase();
        const clash = byLower.get(lower);
        // Two `.env` names differing only by case read the SAME `DS_*` keys, so they are
        // the same datasource wearing two labels. Refuse rather than serve the duplicate.
        if (clash) {
            throw new Error(
                `datasources "${clash}" and "${name}" differ only by case, so both read the same ` +
                    `DS_${lower.toUpperCase()}_* keys. Rename one — datasource names are case-insensitive.`,
            );
        }
        byLower.set(lower, name);
    }
    for (const name of dir.names) {
        const clash = byLower.get(name.toLowerCase());
        if (clash !== undefined) {
            throw new Error(
                `datasource "${clash}" is defined in both .env and ${dir.files[name]}` +
                    (clash === name ? '' : ` (names differ only by case, and are case-insensitive)`) +
                    ' — refusing rather than silently overriding a credential. Remove one.',
            );
        }
    }

    // `readDatasourcesDir` deliberately emits no `DATASOURCES` key — emitting it there
    // would clobber `.env`'s id list and unload every `.env` datasource. The union happens
    // here, once, where both sides are known.
    const merged: ConfigSource = { ...baseEnv, ...envFile };

    if (Object.keys(fallbackKeys).length > 0) {
        // The fallback expresses `main` ENTIRELY from `DATABASE_*`, which is what
        // `loadConfig` does when it takes this path. Strip any stray `DS_MAIN_*` first, or
        // a key the fallback map does not cover (`DS_MAIN_WRITABLE`, `DS_MAIN_POOL_MAX`, …)
        // would survive and half-override a datasource the operator never wrote in `DS_*`
        // form at all — a hybrid nobody authored. Safe to strip unconditionally here:
        // fallbackKeys is non-empty only when `DATASOURCES` was empty, so nothing else
        // refers to `main`.
        for (const key of Object.keys(merged)) {
            if (key.startsWith('DS_MAIN_')) delete merged[key];
        }
        Object.assign(merged, fallbackKeys);
    }

    // Strip EVERY `DS_<NAME>_*` key for a directory-defined datasource before layering the
    // file's own keys on top — the same rule as the fallback strip above, and missing it
    // was a fail-OPEN hole.
    //
    // The collision check compares directory names against the `DATASOURCES` id LIST, so a
    // leftover `DS_WAREHOUSE_*` block for a name no longer in that list is invisible to it.
    // `dir.source` then overwrites only the keys the FILE actually sets, and every other
    // leftover survives. The trigger is the migration this README section invites: move a
    // datasource out of `.env` into `datasources.d/`, drop it from `DATASOURCES`, forget to
    // delete its old key block. The file-defined datasource — authored read-only, guards on
    // — then comes up with `DS_WAREHOUSE_WRITABLE=true` and `DS_WAREHOUSE_ALLOW_UNSAFE_
    // STATEMENTS=true` from keys the operator believed were inert, on a stale password.
    // Uppercased prefix, because that is how `buildDatasource` derives its lookup.
    for (const name of dir.names) {
        const prefix = `DS_${name.toUpperCase()}_`;
        for (const key of Object.keys(merged)) {
            if (key.startsWith(prefix)) delete merged[key];
        }
    }

    Object.assign(merged, dir.source, { DATASOURCES: [...envNames, ...dir.names].join(',') });

    return { merged, dirNames: dir.names, dirFiles: dir.files, dir: dir.dir };
}

/**
 * Boot-time convenience: gather every source and validate. Throws on any problem, which is
 * the correct boot behaviour — nothing is serving yet, so a bad config must not start.
 * Reload calls `gatherConfigSources` directly instead, because it needs to REFUSE (leaving
 * the running config untouched) rather than exit.
 */
export function resolveConfig(opts: GatherOptions = {}): RootConfig {
    return loadConfig(gatherConfigSources(opts).merged);
}
