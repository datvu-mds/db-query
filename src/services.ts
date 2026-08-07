/**
 * buildServices — single wiring point for the whole gateway. Both entrypoints
 * (HTTP `server.ts` and MCP `mcp/mcp-server.ts`) construct their services here so
 * guardrails/auth/audit are identical across transports (Phase 4 reuses this).
 *
 * The driver is injectable so tests can drive the full HTTP/MCP path against a
 * stub (no live Postgres) — production passes the PostgresDriver.
 */
import pino from 'pino';
import type { Logger } from 'pino';
import type { RootConfig } from './config/config.schema.js';
import { PoolManager } from './pool/pool-manager.js';
import { HealthChecker } from './pool/health-checker.js';
import { PostgresDriver } from './driver/postgres-driver.js';
import { QueryService } from './query/query-service.js';
import { IntrospectService } from './introspect/introspect-service.js';
import { TokenAuth } from './auth/token-auth.js';
import { AuditLogger } from './audit/audit-logger.js';
import type { QueryDriver } from './driver/query-driver.js';

export interface Services {
    config: RootConfig;
    logger: Logger;
    pools: PoolManager;
    driver: QueryDriver;
    health: HealthChecker;
    queryService: QueryService;
    introspectService: IntrospectService;
    auth: TokenAuth;
    audit: AuditLogger;
}

export function buildServices(config: RootConfig, logger?: Logger, driverOverride?: QueryDriver): Services {
    const log = logger ?? pino({ level: config.logLevel });
    const pools = new PoolManager(config.datasources, log);
    const driver = driverOverride ?? new PostgresDriver(pools);
    const audit = new AuditLogger(log);
    const queryService = new QueryService(driver, pools, config.maxRowsCeiling, audit);
    const introspectService = new IntrospectService(queryService, pools);
    const auth = new TokenAuth(config.tokens);
    // TTL knob (default 5s): bounds how stale a /health result may be vs. how often
    // probes hit the DB. 0 disables caching (re-ping every request).
    const healthTtlMs = Number(process.env.HEALTH_CACHE_TTL_MS ?? 5000);
    const health = new HealthChecker(driver, Number.isFinite(healthTtlMs) ? healthTtlMs : 5000);

    return { config, logger: log, pools, driver, health, queryService, introspectService, auth, audit };
}
