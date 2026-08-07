/**
 * IntrospectService — structure discovery (schemas / tables / columns). Every
 * method is a fixed, parameterized read-only catalog SELECT executed through the
 * SAME guarded QueryService path — so tenant `search_path`, timeouts, read-only
 * enforcement and audit are identical to /query. No direct pool/driver access.
 *
 * Catalog queries fully qualify `information_schema.*`, so they don't depend on
 * search_path; we still run them inside the guarded txn for uniform guardrails.
 */
import type { QueryService, InternalTrust } from '../query/query-service.js';
import type { PoolManager } from '../pool/pool-manager.js';
import type { Capabilities } from '../auth/token-auth.js';
import { isSystemSchema } from '../query/relation-guard.js';

/** The three SELECTs below are fixed, parameterized information_schema reads — the
 *  sanctioned, caps-filtered metadata path. They MUST bypass the relation guard's
 *  catalog block or list_schemas/list_tables/describe_table break entirely. */
const INTERNAL: InternalTrust = { internalCatalogQuery: true, reason: 'introspection' };

export interface TableInfo {
    name: string;
    type: string; // 'BASE TABLE' | 'VIEW' | ...
}

export interface ColumnInfo {
    name: string;
    dataType: string;
    nullable: boolean;
    default: string | null;
    position: number;
}

const SCHEMAS_SQL = 'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name';
const TABLES_SQL =
    'SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name';
const DESCRIBE_SQL =
    'SELECT column_name, data_type, is_nullable, column_default, ordinal_position ' +
    'FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position';

export class IntrospectService {
    constructor(
        private readonly queryService: QueryService,
        private readonly pools: PoolManager,
    ) {}

    /** List schemas visible to the token: non-system, and within its `schemas` caps. */
    async listSchemas(caps: Capabilities, datasource: string): Promise<string[]> {
        // search_path is irrelevant to a fully-qualified catalog query; use the
        // datasource default just to satisfy the guarded txn.
        const schema = this.pools.getConfig(datasource).defaultSchema;
        const { response } = await this.queryService.run(
            {
                tokenId: caps.id,
                datasource,
                schema,
                sql: SCHEMAS_SQL,
                write: false,
            },
            INTERNAL,
        );
        return response.rows.map((r) => String(r.schema_name)).filter((name) => this.visibleSchema(caps, name));
    }

    async listTables(tokenId: string, datasource: string, schema: string): Promise<TableInfo[]> {
        const { response } = await this.queryService.run(
            {
                tokenId,
                datasource,
                schema,
                sql: TABLES_SQL,
                params: [schema],
                write: false,
            },
            INTERNAL,
        );
        return response.rows.map((r) => ({ name: String(r.table_name), type: String(r.table_type) }));
    }

    async describeTable(tokenId: string, datasource: string, schema: string, table: string): Promise<ColumnInfo[]> {
        const { response } = await this.queryService.run(
            {
                tokenId,
                datasource,
                schema,
                sql: DESCRIBE_SQL,
                params: [schema, table],
                write: false,
            },
            INTERNAL,
        );
        return response.rows.map((r) => ({
            name: String(r.column_name),
            dataType: String(r.data_type),
            nullable: r.is_nullable === 'YES',
            default: r.column_default == null ? null : String(r.column_default),
            position: Number(r.ordinal_position),
        }));
    }

    /** Exclude system schemas; apply the token's `schemas` capability. Uses the shared
     *  isSystemSchema so this policy cannot drift from the relation guard's. */
    private visibleSchema(caps: Capabilities, name: string): boolean {
        if (isSystemSchema(name)) return false;
        return caps.schemas.includes('*') || caps.schemas.includes(name);
    }
}
