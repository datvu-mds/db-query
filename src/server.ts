/**
 * server.ts — HTTP entrypoint. Loads + validates config (fail-fast), wires
 * services, does a boot ping per datasource (refuse to start if any is
 * unreachable), listens, and installs a graceful SIGTERM/SIGINT shutdown that
 * drains the pools.
 */
import { resolveConfig } from './config/config-sources.js';
import { buildServices } from './services.js';
import { buildApp } from './build-app.js';
import { assertBindAllowed } from './config/bind-guard.js';
import { assertReadOnlyPosture } from './boot/assert-readonly-posture.js';
import { installReloadOnSighup } from './config/reload.js';

/** Cap on waiting for an in-flight reload during shutdown. Below any sane
 *  orchestrator grace period, so we drain deliberately rather than being SIGKILLed. */
const SHUTDOWN_RELOAD_WAIT_MS = 5000;

async function main(): Promise<void> {
    // resolveConfig, NOT loadConfig: boot must read `datasources.d/` too. Reading only
    // `process.env` here is what made a directory-defined datasource exist solely after a
    // SIGHUP — vanishing on the next restart, or failing boot outright when a token named
    // it. Boot and reload now gather sources through the one function.
    const config = resolveConfig();
    // Before touching the DB: refuse a wildcard bind unless explicitly allowed.
    assertBindAllowed(config.host, 'HTTP gateway');
    const services = buildServices(config);
    const log = services.logger;

    // Fail-fast boot: one SELECT 1 per datasource. Refuse to start (exit 1) if any
    // configured datasource is unreachable, naming which one.
    for (const name of services.pools.names()) {
        try {
            await services.pools.ping(name);
            log.info({ datasource: name }, 'datasource reachable');
        } catch (err) {
            log.fatal({ datasource: name, err: (err as Error).message }, 'datasource unreachable — refusing to start');
            await services.pools.drainAll();
            process.exit(1);
        }
    }

    // Reachability is proven; now state whether the DB itself is the read-only
    // backstop. Non-fatal by design (see assert-readonly-posture.ts).
    await assertReadOnlyPosture(services);

    const app = buildApp(services);
    await app.listen({ port: config.port, host: config.host });

    // SIGHUP re-reads `.env` + `datasources.d/` and applies the diff to this running
    // process. Serialized, so overlapping signals cannot interleave two reloads. This is
    // the zero-downtime path for the long-running HTTP gateway — the deployment where it
    // matters. Not deliverable on Windows; restart instead (README).
    const reloader = installReloadOnSighup(services);
    log.info('SIGHUP will reload datasources and token grants (kill -HUP <pid>)');

    // Graceful shutdown: stop accepting → close server (drains in-flight) → end pools.
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info({ signal }, 'shutting down');
        try {
            await app.close();
        } catch (err) {
            log.error({ err: (err as Error).message }, 'error closing server');
        }
        // Let an in-flight reload finish before draining: it may be mid-swap, and ending
        // pools underneath it would strand a half-applied config on the way out.
        // Bounded: a reload in flight must not eat the whole SIGTERM grace period.
        await reloader.idle(SHUTDOWN_RELOAD_WAIT_MS);
        await services.pools.drainAll();
        log.info('pools drained; exiting');
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
    // Boot failure (invalid config, unexpected error) — fail fast, clear message.
    console.error(`[pg-connection-pool] fatal: ${(err as Error).message}`);
    process.exit(1);
});
