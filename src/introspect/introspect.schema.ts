/** Zod request schemas for the three introspection routes. */
import { z } from 'zod';

export const schemasRequestSchema = z.object({
    datasource: z.string().min(1),
});

export const tablesRequestSchema = z.object({
    datasource: z.string().min(1),
    schema: z.string().min(1),
});

export const describeRequestSchema = z.object({
    datasource: z.string().min(1),
    schema: z.string().min(1),
    table: z.string().min(1),
});

export type SchemasRequest = z.infer<typeof schemasRequestSchema>;
export type TablesRequest = z.infer<typeof tablesRequestSchema>;
export type DescribeRequest = z.infer<typeof describeRequestSchema>;
