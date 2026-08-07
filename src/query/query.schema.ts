/**
 * Request/response contract for POST /query (and the MCP run_query tool).
 *
 * `readOnly` defaults to TRUE — writes are opt-in and require BOTH a write-capable
 * token AND an explicit `readOnly:false` (the double gate; see token-auth + Phase 3).
 * `maxRows` / `timeoutMs` are hints; the server clamps them to hard/per-datasource
 * ceilings in QueryService.
 */
import { z } from 'zod';

export const queryRequestSchema = z.object({
    datasource: z.string().min(1),
    schema: z.string().min(1).optional(), // omit → datasource default schema
    sql: z.string().min(1),
    params: z.array(z.unknown()).optional(),
    readOnly: z.boolean().default(true),
    maxRows: z.coerce.number().int().positive().optional(),
    timeoutMs: z.coerce.number().int().positive().optional(),
});

export type QueryRequest = z.infer<typeof queryRequestSchema>;

export interface QueryColumn {
    name: string;
    dataType: string;
}

export interface QueryResponse {
    columns: QueryColumn[];
    rows: Record<string, unknown>[];
    rowCount: number;
    truncated: boolean;
    elapsedMs: number;
    /** Populated only on the write path (Phase 3): rows affected by the command. */
    rowsAffected?: number;
}
