/**
 * check-config — validate the merged config WITHOUT touching a database.
 *
 *     node --import tsx scripts/check-config.mts
 *
 * Runs the real boot path (`resolveConfig` → `gatherConfigSources` → zod → the
 * token cross-reference) so it catches everything a boot would catch EXCEPT
 * reachability: a `datasources.d/` file at the wrong mode, an unknown key, a
 * name defined in two sources, a token naming a datasource that does not exist.
 *
 * It deliberately prints no secret: names, flags and grants only. Run it from
 * the project root — `datasources.d/` resolves CWD-relative.
 *
 * Exits 1 with the loader's own operator-actionable message on failure, so it
 * also works as a pre-deploy gate.
 */
import { resolveConfig } from '../src/config/config-sources.js';

try {
    const cfg = resolveConfig();

    console.log(`datasources (${cfg.datasources.length}):`);
    for (const d of cfg.datasources) {
        const flags = [
            d.writable ? 'WRITABLE' : 'read-only',
            d.allowUnsafeStatements ? 'GUARDS OFF' : 'guards on',
            d.sensitiveRelationDenylist ? 'sensitive-denylist on' : 'sensitive-denylist OFF',
        ];
        if (d.deniedTables.length) flags.push(`denied:${d.deniedTables.length}`);
        // host/port/database are not secrets, and seeing them is how you catch a
        // file that was copied but never edited. The password is never printed.
        console.log(`  ${d.name.padEnd(12)} ${d.host}:${d.port}/${d.database} schema=${d.defaultSchema} ssl=${d.ssl} [${flags.join(', ')}]`);
    }

    console.log(`tokens (${cfg.tokens.length}):`);
    for (const t of cfg.tokens) {
        console.log(`  ${t.id.padEnd(12)} mode=${t.mode} datasources=[${t.datasources.join(', ')}] schemas=[${t.schemas.join(', ')}]`);
    }

    const writable = cfg.datasources.filter((d) => d.writable).map((d) => d.name);
    const writeTokens = cfg.tokens.filter((t) => t.mode === 'write').map((t) => t.id);
    if (writable.length) console.log(`WARN: writable datasources: ${writable.join(', ')}`);
    if (writeTokens.length && !writable.length) console.log(`WARN: write-mode token(s) ${writeTokens.join(', ')} exist but NO datasource is writable — every write will 403.`);

    console.log('config OK (reachability not checked — boot still pings every datasource)');
} catch (err) {
    console.error(`CONFIG INVALID: ${(err as Error).message}`);
    process.exit(1);
}
