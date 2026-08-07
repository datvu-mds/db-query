/**
 * Zod schemas for the gateway configuration. These validate the *assembled*
 * config object (built from `.env` by load-config.ts) and, on failure, are the
 * fail-fast boundary — the server refuses to boot with an invalid config.
 *
 * Note on booleans: we intentionally do NOT use `z.coerce.boolean()` here.
 * `Boolean("false") === true`, so string→boolean coercion is done in
 * load-config.ts (`"true"` ⇒ true) and this schema receives a real boolean.
 */
import { z } from 'zod';

export const datasourceSchema = z.object({
    name: z.string().min(1),
    host: z.string().min(1),
    // z.coerce.number turns the env string into a number; .default applies only
    // when the loader passes `undefined` (missing/empty env key).
    port: z.coerce.number().int().positive().default(5432),
    user: z.string().min(1),
    password: z.string(), // may legitimately be empty for trust-auth local DBs
    database: z.string().min(1),
    ssl: z.boolean().default(false),
    defaultSchema: z.string().min(1).default('public'),
    poolMax: z.coerce.number().int().positive().default(5),
    statementTimeoutMs: z.coerce.number().int().positive().default(10000),
    idleTimeoutMs: z.coerce.number().int().nonnegative().default(10000),
    connectionTimeoutMs: z.coerce.number().int().nonnegative().default(5000),
    maxUses: z.coerce.number().int().nonnegative().default(7500),
    // Escape hatch: when true, the per-statement guard (statement-guard.ts) AND the
    // relation guard (relation-guard.ts) are skipped for this datasource — dangerous/
    // admin statements (COPY, pg_read_file, …) and catalog/denied-table reads are
    // permitted. Default false = guards enforced. The multi-statement scan and the
    // read-only transaction stay on regardless. Enabling it re-exposes the
    // RCE/file-access class IFF the DB role is privileged, so boot logs a WARN.
    allowUnsafeStatements: z.boolean().default(false),
    // Per-datasource sensitive-relation denylist enforced by the relation guard
    // (relation-guard.ts). Entries are `table` (matches in ANY schema) or `schema.table`
    // (exact). Code default is EMPTY on purpose: the gateway stays generic, and
    // deployments declare their own list in .env. Skipped by allowUnsafeStatements,
    // like the statement guard.
    deniedTables: z
        .array(z.string().min(1).regex(/^[^.]+(\.[^.]+)?$/, 'expected "table" or "schema.table"'))
        .default([]),
});

export const tokenSchema = z.object({
    id: z.string().min(1),
    secret: z.string().min(1),
    // ['*'] = all datasources; otherwise an explicit allow-list of logical names.
    datasources: z.array(z.string().min(1)).min(1),
    // 'write' implies read too; a 'read' token can never write (enforced in token-auth).
    mode: z.enum(['read', 'write']).default('read'),
    // ['*'] = any non-system schema; otherwise an explicit allow-list.
    schemas: z.array(z.string().min(1)).min(1),
});

export const rootConfigSchema = z.object({
    port: z.coerce.number().int().positive().default(3200),
    // Loopback by default: this gateway holds DB credentials, so a public bind must
    // be an explicit opt-in (HOST=0.0.0.0 + ALLOW_PUBLIC_BIND=true — see bind-guard.ts).
    host: z.string().min(1).default('127.0.0.1'),
    logLevel: z.string().min(1).default('info'),
    maxRowsCeiling: z.coerce.number().int().positive().default(10000),
    datasources: z.array(datasourceSchema).min(1),
    tokens: z.array(tokenSchema).min(1),
});

export type DatasourceConfig = z.infer<typeof datasourceSchema>;
export type TokenConfig = z.infer<typeof tokenSchema>;
export type RootConfig = z.infer<typeof rootConfigSchema>;
