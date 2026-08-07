/**
 * Boot-time read-only posture assertion.
 *
 * The gateway's read-only guarantee has historically lived entirely in app code
 * (read-mode tokens + `BEGIN TRANSACTION READ ONLY`). That is one bug or one env
 * flip away from being gone, so what actually matters is whether the *database*
 * role can write at all. This probe answers that at every boot and states the
 * answer in the log, per datasource.
 *
 * Deliberately WARN-level, never fatal: a legitimately write-capable datasource
 * may exist later, and a boot-blocking security check invites people to delete it.
 * The value here is visibility — a misconfiguration becomes loud instead of being
 * found in an audit six months later.
 *
 * The probe runs through QueryService, so it is audited and wrapped in the same
 * read-only transaction as any other read — no unguarded query surface is added.
 *
 * FAIL CLOSED. Every uncertain outcome (probe error, missing row, unparseable
 * value) is reported as UNVERIFIED, never as OK. A security check that reports a
 * false all-clear is worse than no check, because it stops people looking.
 */
import type { Services } from '../services.js';
import type { TokenConfig } from '../config/config.schema.js';
import type { InternalTrust } from '../query/query-service.js';
import { extractSqlRefs } from '../query/relation-guard.js';

/** Audit identity for the probe — not a real token; filterable in the audit stream. */
const BOOT_TOKEN_ID = 'boot:posture';

/** PROBE_SQL reads pg_roles/pg_class/pg_namespace (unqualified pg_%). Without this the
 *  relation guard would reject it and EVERY boot would report posture UNVERIFIED, i.e.
 *  the security check would silently die. This is the gateway's own fixed catalog SQL. */
const INTERNAL: InternalTrust = { internalCatalogQuery: true, reason: 'boot-probe' };

/** Bound the catalog scan; a slow boot probe must not stall the transport. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * We ask "can this role write?", NOT "how many write grants name this role?".
 *
 * The obvious query — counting `information_schema.table_privileges` — is built
 * from `relacl`, so it silently misses every write capability that leaves no ACL
 * row on the table: column-level grants (`pg_attribute.attacl`), membership in the
 * predefined `pg_write_all_data` role (PG14+, implicit in the ACL check), and
 * superuser. Each of those yields a count of 0 for a role that can write every
 * table — a false all-clear, which is the one failure mode this check must not have.
 *
 * `has_table_privilege` / `has_any_column_privilege` route through the same ACL
 * check the executor uses, so predefined-role and superuser shortcuts are included
 * by construction. Superuser and `pg_write_all_data` are ALSO reported explicitly,
 * because those grant write on future relations too — a zero count today would
 * otherwise read as safe.
 *
 * `default_transaction_read_only` is the GUC a *plain* BEGIN inherits — distinct
 * from `transaction_read_only`, which our own `BEGIN TRANSACTION READ ONLY` sets.
 * Reading it inside the read path therefore still reports the role/session default.
 * Note it is USERSET (a caller can turn it off), so it is a second lock, never the
 * primary one — the grants are.
 *
 * The `CASE` around `to_regrole` (not `AND`) matters: SQL does not guarantee `AND`
 * short-circuits, and `pg_has_role` errors on a role that does not exist. `MEMBER`
 * rather than `USAGE` is deliberate — a NOINHERIT member can still `SET ROLE` and
 * write, so membership is the conservative predicate for a posture check.
 */
const PROBE_SQL = `
    SELECT current_user AS db_user,
           current_setting('default_transaction_read_only') AS default_read_only,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
           CASE WHEN to_regrole('pg_write_all_data') IS NULL THEN false
                ELSE pg_has_role(current_user, to_regrole('pg_write_all_data')::oid, 'MEMBER') END AS write_all_data,
           (SELECT count(*)::int
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm')
               AND n.nspname NOT IN ('pg_catalog', 'information_schema')
               AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
                 OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE')
                 OR has_any_column_privilege(c.oid, 'INSERT') OR has_any_column_privilege(c.oid, 'UPDATE'))
           ) AS writable_relations`;
// Aliases are snake_case deliberately: Postgres folds unquoted identifiers to lower
// case, so `AS writableRelations` would arrive as `writablerelations` and every
// camelCase lookup would miss. (Caught by the boot probe reporting UNVERIFIED — which
// is exactly why the strict readers below must fail closed rather than default to 0.)

interface Posture {
    dbUser: string;
    defaultReadOnly: boolean;
    isSuperuser: boolean;
    writeAllData: boolean;
    writableRelations: number;
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Strict column readers. `Number()`/`=== true` are NOT safe here: `Number(null)`,
 * `Number('')` and `Number(false)` are all 0, and `undefined === true` is false —
 * so a missing or NULL column would read as "zero writable relations, not a
 * superuser", i.e. a false all-clear. Anything unexpected must raise instead, which
 * the caller turns into UNVERIFIED.
 */
function requireCount(row: Record<string, unknown>, column: string): number {
    const raw = row[column];
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`posture probe returned an unusable ${column} (${JSON.stringify(raw)})`);
    }
    return value;
}

function requireBool(row: Record<string, unknown>, column: string): boolean {
    const raw = row[column];
    if (typeof raw !== 'boolean') {
        throw new Error(`posture probe returned an unusable ${column} (${JSON.stringify(raw)})`);
    }
    return raw;
}

/** Tokens that can reach this datasource and are write-mode ('*' = all datasources). */
function writeTokensFor(tokens: TokenConfig[], datasource: string): string[] {
    return tokens
        .filter((t) => t.mode === 'write' && (t.datasources.includes('*') || t.datasources.includes(datasource)))
        .map((t) => t.id);
}

async function probe(services: Services, datasource: string): Promise<Posture> {
    const { response } = await services.queryService.run(
        {
            tokenId: BOOT_TOKEN_ID,
            datasource,
            schema: services.pools.getConfig(datasource).defaultSchema,
            sql: PROBE_SQL,
            write: false,
            timeoutMs: PROBE_TIMEOUT_MS,
        },
        INTERNAL,
    );

    // Fail closed: an unexpected shape must NOT collapse into "nothing writable → OK".
    const row = response.rows[0];
    if (!row) throw new Error('posture probe returned no rows');

    return {
        dbUser: String(row.db_user ?? 'unknown'),
        // Advisory second lock only, so a surprise here is not worth failing the probe.
        defaultReadOnly: row.default_read_only === 'on',
        isSuperuser: requireBool(row, 'is_superuser'),
        writeAllData: requireBool(row, 'write_all_data'),
        writableRelations: requireCount(row, 'writable_relations'),
    };
}

/**
 * Probe every datasource and log its posture. Never throws — a probe failure is
 * itself reported as UNVERIFIED so boot proceeds.
 *
 * `identity` (the token this process runs as, when there is one) sharpens the
 * signal: an MCP process running as a read-mode token is not actually reachable by
 * some other write token sitting in `.env`.
 */
export async function assertReadOnlyPosture(services: Services, identity?: string): Promise<void> {
    const log = services.logger;

    // Load the WASM parser once at boot so the first user query doesn't pay for it and
    // a broken install is loud here rather than as a 400 on someone's query.
    try {
        await extractSqlRefs('SELECT 1');
    } catch (err) {
        log.error(
            { err: err instanceof Error ? err.message : String(err) },
            'SQL parser failed to initialise — every guarded query will be rejected (relation guard fails closed)',
        );
    }

    for (const datasource of services.pools.names()) {
        const dsCfg = services.pools.getConfig(datasource);

        // Loud when the guards have been switched off: this re-exposes the
        // COPY/file/signal class AND catalog/denied-table reads IFF the DB role is
        // privileged, so it cross-references the posture verdict below rather than
        // standing alone.
        if (dsCfg.allowUnsafeStatements) {
            log.warn(
                { datasource, allowUnsafeStatements: true },
                `statement guard DISABLED for datasource "${datasource}" (ALLOW_UNSAFE_STATEMENTS=true) — ` +
                    'dangerous statements (COPY, pg_read_file, backend signals, …) are permitted AND the ' +
                    'relation guard is also DISABLED (catalog/metadata reads and denied tables are permitted); ' +
                    'ensure this datasource points at a trusted DB role',
            );
        } else {
            log.info(
                { datasource, deniedTables: dsCfg.deniedTables.length, catalogBlock: true },
                `relation guard ENFORCED for datasource "${datasource}" — catalog/information_schema blocked in ` +
                    `run_query, ${dsCfg.deniedTables.length} denied table pattern(s)`,
            );
        }

        const writeTokens = writeTokensFor(services.config.tokens, datasource);

        let posture: Posture;
        try {
            posture = await probe(services, datasource);
        } catch (err) {
            log.warn(
                { datasource, identity, err: errMessage(err) },
                'read-only posture UNVERIFIED — could not probe DB privileges; assume the app gate is the only barrier',
            );
            continue;
        }

        // The DB is the backstop only when the role cannot write anything, and holds
        // neither of the blanket capabilities that would also cover future relations.
        const backstop = posture.writableRelations === 0 && !posture.isSuperuser && !posture.writeAllData;
        const fields = { datasource, identity, ...posture, writeTokens, backstop };

        if (backstop) {
            log.info(
                fields,
                posture.defaultReadOnly
                    ? 'read-only posture OK — DB role can write no relation and defaults transactions to read-only'
                    : 'read-only posture OK — DB role can write no relation (default_transaction_read_only is off; grants are the real barrier)',
            );
        } else if (writeTokens.length > 0) {
            log.warn(
                fields,
                'read-only posture WEAK — write-capable DB role reachable through a write-mode token; ' +
                    'the DB is NOT the read-only backstop, only app logic is',
            );
        } else {
            log.warn(
                fields,
                'read-only posture WEAK — DB role can write; no write-mode token exists today, ' +
                    'so only app logic prevents writes. Point this datasource at a read-only role',
            );
        }
    }
}
