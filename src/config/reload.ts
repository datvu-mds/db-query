/**
 * reload.ts — re-read `.env` + `datasources.d/` and apply the difference to a RUNNING
 * process, without dropping a request or losing an in-flight query.
 *
 * TWO STAGES, WITH DIFFERENT FAILURE SEMANTICS. The split is the whole feature:
 *
 *   Stage 1 — VALIDATION, ALL-OR-NOTHING. Permissions, parse, zod, cross-source name
 *     collision, and the MCP process identity. Any failure logs and returns with the
 *     running config bit-for-bit unchanged. A half-applied reload is worse than a
 *     refused one, because the operator cannot tell which half landed.
 *
 *   Stage 2 — PROBES, PER-DATASOURCE DEGRADE. The server never dies here. One
 *     unreachable datasource is withheld and logged; its siblings still publish.
 *
 * Boot and reload deliberately share one rule set (Design Decision 6) — the same files
 * must not mean different things depending on how the process started. The ONLY
 * sanctioned divergence: a `ping` failure is FATAL at boot (nothing is serving yet) and
 * WITHHELD on reload (something is).
 *
 * Nothing above `Services` learns about reload. `PoolManager` and `TokenAuth` are
 * mutated in place and `services.config` is reassigned, so routes and MCP tools keep the
 * `Services` reference they captured at registration and the objects behind it change.
 */
import type { Services } from '../services.js';
import type { Capabilities } from '../auth/token-auth.js';
import { TokenAuth } from '../auth/token-auth.js';
import { loadConfig, type ConfigSource } from './load-config.js';
import { gatherConfigSources } from './config-sources.js';
import { assertReadOnlyPosture } from '../boot/assert-readonly-posture.js';
import type { RootConfig } from './config.schema.js';

export interface ReloadOptions {
    /** Path to `.env`. Defaults to CWD-relative `./.env`, mirroring `--env-file-if-exists=.env`. */
    envPath?: string;
    /** Datasource directory. Defaults to `DATASOURCES_DIR` or CWD-relative `./datasources.d`. */
    datasourcesDir?: string;
    /**
     * The stdio MCP server's LIVE capability object — the one `registerTools()` closed
     * over. Refreshed in place with `Object.assign` so every already-registered handler
     * sees new grants without re-registration.
     */
    liveCaps?: Capabilities;
    /** The bearer secret this process runs as (`MCP_TOKEN`), re-authenticated in stage 1. */
    mcpToken?: string;
    /** Token id for posture log attribution; also names the identity in a refusal message. */
    identity?: string;
    /**
     * Comparison baseline for the boot-only keys that never enter `RootConfig`.
     * Defaults to `process.env`, which is sound because PRODUCTION CODE NEVER WRITES IT —
     * so it still holds each key's boot value. Injectable so tests need not mutate globals.
     */
    baseEnv?: ConfigSource;
}

export interface ReloadReport {
    /**
     * Whether STAGE 1 passed and the diff was applied. `false` ⇒ a stage-1 refusal and
     * nothing changed at all.
     *
     * `ok: true` deliberately does NOT mean everything succeeded — stage 2 degrades per
     * datasource by design, so a reload can be `ok` while individual datasources are
     * `withheld` or stuck on `retainedPrevious`. Automation must inspect those arrays;
     * keying on `ok` alone would miss a failed policy tightening. Flipping `ok` for a
     * per-datasource outcome was considered and rejected: it would conflate "your config
     * was rejected wholesale, nothing moved" with "most of it applied", which are the two
     * states an operator most needs to tell apart.
     */
    ok: boolean;
    refusedReason?: string;
    added: string[];
    changed: string[];
    removed: string[];
    /** NOT SERVING — construction, ping or pre-publish probe failed. */
    withheld: { name: string; reason: string }[];
    /** SERVING, but posture could not be established (changed path only). */
    postureUnverified: { name: string; reason: string }[];
    /**
     * SERVING, on the PREVIOUS config — the candidate could not be built or failed its
     * pre-swap ping, so the change never applied. Security-relevant: because change
     * detection is a full deep-compare while the gate is a network `SELECT 1`, a
     * POLICY-ONLY tightening can fail on a transient blip and leave the LOOSER previous
     * policy live. Retried automatically on the next reload.
     */
    retainedPrevious: { name: string; reason: string }[];
    /** Boot-only keys that differ and require a restart. Warned, never applied. */
    bootOnlyChanged: string[];
}

/**
 * Serialize reloads so overlapping SIGHUPs cannot interleave two of them.
 *
 * COALESCING, not queueing: a signal arriving while a reload is in flight sets a single
 * pending flag, and exactly ONE more reload runs afterwards no matter how many signals
 * landed. Queueing every signal would let `while true; do kill -HUP $pid; done` pile up
 * unbounded work; dropping them outright would ignore an edit the operator made during
 * the window. One trailing run applies the latest state on disk, which is what they meant.
 *
 * Returned as an object rather than installed directly so tests can drive `trigger()`
 * without sending real signals to the test runner's own process.
 */
export function createReloadRunner(
    services: Services,
    options: ReloadOptions = {},
): { trigger(): void; idle(timeoutMs?: number): Promise<void> } {
    let running: Promise<void> | null = null;
    let pending = false;

    const run = async (): Promise<void> => {
        do {
            pending = false;
            try {
                await reloadConfig(services, options);
            } catch (err) {
                // reloadConfig is contracted not to throw; this is the backstop that keeps
                // an unexpected bug from becoming an unhandled rejection that kills a
                // long-running gateway.
                services.logger.error({ event: 'config-reload', err: errMessage(err) }, 'config reload failed unexpectedly');
            }
        } while (pending);
        running = null;
    };

    return {
        trigger(): void {
            if (running) {
                pending = true;
                return;
            }
            running = run();
        },
        /**
         * Resolves once no reload is in flight — for tests and graceful shutdown.
         *
         * `timeoutMs` BOUNDS the wait, and shutdown must pass one. `applyDatasources` is
         * sequential over the diff and each added/changed datasource can cost up to
         * `connectionTimeoutMs` (5s) on the ping plus `PROBE_TIMEOUT_MS` (5s) on the
         * posture probe, so an unbounded wait exceeds a default 30s Kubernetes
         * `terminationGracePeriodSeconds` at three changed datasources — and gets
         * SIGKILLed mid-drain, which is the exact outcome awaiting `idle()` was added to
         * prevent. Better to proceed to the drain slightly early than to be killed during
         * it. Omitting the bound keeps the old behaviour for tests.
         */
        async idle(timeoutMs?: number): Promise<void> {
            if (timeoutMs === undefined) {
                while (running) await running;
                return;
            }
            const deadline = Date.now() + timeoutMs;
            while (running && Date.now() < deadline) {
                let timer: NodeJS.Timeout | undefined;
                await Promise.race([
                    running,
                    new Promise<void>((r) => {
                        timer = setTimeout(r, Math.max(0, deadline - Date.now()));
                    }),
                ]);
                if (timer) clearTimeout(timer);
            }
        },
    };
}

/** Install the SIGHUP handler. Returns the runner so a caller can await `idle()`. */
export function installReloadOnSighup(
    services: Services,
    options: ReloadOptions = {},
): ReturnType<typeof createReloadRunner> {
    const runner = createReloadRunner(services, options);
    // SIGHUP over fs.watch: a signal is explicit, atomic, scriptable and testable, and
    // never fires mid-write on a half-written credential file. NOT deliverable on
    // Windows — documented in the README; the restart workflow remains for that case.
    process.on('SIGHUP', () => runner.trigger());
    return runner;
}

/**
 * Boot-only keys, split by which BASELINE they must be compared against — they are not
 * interchangeable, because only some of these reach `RootConfig`.
 *
 * Group A parses through zod, so the live value lives on `services.config`.
 * Group B never enters `RootConfig` at all (read directly at `services.ts:43`,
 * `bind-guard.ts:49`, `mcp-server.ts:62`, `mcp-http.ts:65`), so the only record of its
 * boot value is `process.env`.
 *
 * `MCP_TOKEN` is deliberately in NEITHER: it is the process identity, and a change to it
 * is handled by the stage-1 identity check rather than a warn.
 */
const BOOT_ONLY_ROOT: { key: string; read: (c: RootConfig) => unknown }[] = [
    { key: 'PORT', read: (c) => c.port },
    { key: 'HOST', read: (c) => c.host },
    { key: 'LOG_LEVEL', read: (c) => c.logLevel },
    { key: 'MAX_ROWS_CEILING', read: (c) => c.maxRowsCeiling },
];

const BOOT_ONLY_ENV = [
    'HEALTH_CACHE_TTL_MS',
    'ALLOW_PUBLIC_BIND',
    'MCP_TRANSPORT',
    'MCP_HTTP_HOST',
    'MCP_HTTP_PORT',
    'DATASOURCES_DIR',
] as const;

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export async function reloadConfig(services: Services, options: ReloadOptions = {}): Promise<ReloadReport> {
    const log = services.logger;
    const baseEnv = options.baseEnv ?? process.env;
    const report: ReloadReport = {
        ok: false,
        added: [],
        changed: [],
        removed: [],
        withheld: [],
        postureUnverified: [],
        retainedPrevious: [],
        bootOnlyChanged: [],
    };

    const refuse = (reason: string): ReloadReport => {
        // Security event: the operator must see that a reload was attempted AND rejected.
        // Names and reasons only — never values.
        log.warn({ event: 'config-reload', outcome: 'refused', reason }, `config reload REFUSED — running config unchanged: ${reason}`);
        report.ok = false;
        report.refusedReason = reason;
        return report;
    };

    // ── STAGE 1 ─────────────────────────────────────────────────────────────────
    // Every failure below returns BEFORE anything is mutated.

    // Gather EVERY source through the same function boot uses, so the two cannot read
    // different worlds (Design Decision 6). Throws on a bad mode, a bad filename, an
    // unknown key, a duplicate name, or a cross-source collision — each with an
    // actionable message naming the file. Boot lets those kill the process; here they
    // become a refusal that changes nothing.
    let gathered: ReturnType<typeof gatherConfigSources>;
    try {
        gathered = gatherConfigSources({ envPath: options.envPath, datasourcesDir: options.datasourcesDir, baseEnv });
    } catch (err) {
        return refuse(errMessage(err));
    }
    const merged: ConfigSource = gathered.merged;

    let next: RootConfig;
    try {
        // No per-source options: `writable` fails closed from EVERY source, so there is
        // nothing for the loader to disambiguate. Reload and boot therefore call
        // loadConfig identically — one rule set, per Design Decision 6.
        next = loadConfig(merged);
    } catch (err) {
        return refuse(errMessage(err));
    }

    // Process identity. Re-AUTHENTICATE the live secret against the CANDIDATE token set
    // rather than matching by id, so a ROTATED SECRET is caught as well as a removed
    // token. Either would leave this process unable to authorize its own tool calls.
    if (options.mcpToken !== undefined) {
        const candidateAuth = new TokenAuth(next.tokens);
        if (!candidateAuth.authenticate(`Bearer ${options.mcpToken}`)) {
            return refuse(
                `this reload would invalidate the token this process runs as ("${options.identity ?? 'unknown'}") — ` +
                    'its id is gone or its secret changed, so the process could no longer authorize its own calls',
            );
        }
    }

    // ── STAGE 2 ─────────────────────────────────────────────────────────────────
    // Validation passed. From here nothing aborts the reload; failures degrade.

    // Boot-only comparison happens BEFORE services.config is reassigned — afterwards the
    // old values are gone and the diff is unrecoverable.
    for (const { key, read } of BOOT_ONLY_ROOT) {
        if (read(services.config) !== read(next)) report.bootOnlyChanged.push(key);
    }
    for (const key of BOOT_ONLY_ENV) {
        if ((merged[key] ?? undefined) !== (baseEnv[key] ?? undefined)) report.bootOnlyChanged.push(key);
    }
    for (const key of report.bootOnlyChanged) {
        // Neither applied silently nor ignored silently — the third option is to say so.
        log.warn(
            { event: 'config-reload', bootOnlyKey: key },
            `boot-only key ${key} changed but CANNOT be applied to a running process — restart required for it to take effect`,
        );
    }

    // Grants and live config first, so the posture probes below report against the NEW
    // token set (`assert-readonly-posture` reads `services.config.tokens` to say which
    // write tokens can reach a datasource). A token briefly granted a not-yet-published
    // datasource simply gets a clean 400 from `datasourceReady()`.
    services.auth.applyTokens(next.tokens);
    // NOTE: a datasource that ends up `retainedPrevious` leaves this claiming the NEW
    // (possibly tightened) config while `pools.getConfig()` — what QueryService actually
    // enforces per run — still holds the old one. Latent today: `services.config` has
    // exactly one reader (`assert-readonly-posture.ts`, which reads `.tokens`), and every
    // request path resolves datasource policy through `pools`. A future reader of
    // `config.datasources` would be reading the aspirational config, not the enforced one.
    services.config = next;

    const namesBefore = new Set(services.pools.names());

    // The probe hooks are how posture reaches a candidate at the one moment each diff
    // path can still act on it — see Design Decision 11. `warmParser: false`: the WASM
    // parser is already warm, and `only` keeps reload cost proportional to the diff
    // rather than to total datasource count.
    const probe = (name: string): Promise<void> =>
        assertReadOnlyPosture(services, options.identity, { only: [name], warmParser: false });

    const applied = await services.pools.applyDatasources(next.datasources, {
        probeAdded: probe,
        probeChanged: probe,
    });

    report.added = applied.added;
    report.changed = applied.changed;
    report.removed = applied.removed;
    report.withheld = applied.withheld;
    report.postureUnverified = applied.postureUnverified;
    report.retainedPrevious = applied.retainedPrevious;

    // Drop cached health verdicts for anything whose pool changed or went away — the
    // checker holds only the driver, so it follows a swap automatically, but a CHANGED
    // datasource would keep serving its pre-swap verdict for up to a full TTL window.
    for (const name of [...applied.changed, ...applied.removed]) services.health.invalidate(name);

    // stdio MCP identity: `registerTools()` closed over the caps OBJECT, so this in-place
    // field update reaches every already-registered handler with no re-registration.
    //
    // Resolved by SECRET, not by id. Stage 1 validates the identity by re-authenticating
    // `mcpToken`, so the secret is the thing it actually proved; an id lookup proves
    // something else. When an operator RENAMES a token id while keeping its secret —
    // `agent` → `agent_ro`, narrowing it to one datasource and read-mode in the same edit
    // — stage 1 passes, `capsById(oldId)` returns null, and a `if (fresh)` guard silently
    // skips the update. The reload reports APPLIED while every registered handler keeps
    // the OLD, WIDER capabilities: a revocation that reports success and does nothing.
    // Renaming is the natural way to narrow an identity, because removing the token
    // outright is refused wholesale by stage 1 — so the fail-open landed on exactly the
    // path an operator would take.
    if (options.liveCaps && options.mcpToken !== undefined) {
        const fresh = services.auth.authenticate(`Bearer ${options.mcpToken}`);
        if (!fresh) {
            // Unreachable: stage 1 authenticated this same secret against the same token
            // set. Fail LOUD rather than silently leaving stale grants in place — a
            // capability set that cannot be refreshed must never be assumed current.
            log.error(
                { event: 'config-reload', identity: options.liveCaps.id },
                'live MCP capabilities could NOT be refreshed after a reload that stage 1 accepted — ' +
                    'the running process may still hold pre-reload grants; restart it',
            );
        } else {
            // Clone via capsById rather than assigning `fresh` directly: `authenticate()`
            // returns the STORE's own caps object, and `liveCaps` is held for the process
            // lifetime by every registered handler. Assigning it would alias the store's
            // arrays into that long-lived object, so a later mutation of live caps would
            // silently widen the stored token's grants. `capsById` clones both arrays.
            const cloned = services.auth.capsById(fresh.id);
            if (cloned) Object.assign(options.liveCaps, cloned);
        }
    } else if (options.liveCaps) {
        // `liveCaps` without `mcpToken` cannot be refreshed safely — the secret is the only
        // thing that identifies this process across a token rename. Both callers pass both.
        log.warn(
            { event: 'config-reload' },
            'liveCaps supplied without mcpToken — live MCP capabilities were NOT refreshed',
        );
    }

    report.ok = true;

    // Per-datasource diagnosis, SEPARATE from the security event below.
    //
    // The security event is names-only by contract, but a name alone is useless to an
    // operator: a datasource simply vanishes with no way to tell "wrong password" from
    // "DB down". The reason lives here instead, at the same tier as the existing
    // `pool.on('error')` and posture lines — server-side detail, which CLAUDE.md places
    // in the server log rather than in anything caller-facing. A `pg` connect error can
    // name the host or user (never the password), which is exactly the operator-facing
    // detail this line exists to carry, and is why it is kept OUT of the event below.
    for (const { name, reason } of report.withheld) {
        log.warn({ event: 'config-reload', datasource: name, reason }, `datasource "${name}" WITHHELD — not serving: ${reason}`);
    }
    for (const { name, reason } of report.retainedPrevious) {
        log.warn(
            { event: 'config-reload', datasource: name, reason },
            `datasource "${name}" kept its PREVIOUS config — the change could not be applied: ${reason}. ` +
                'If the change was a tightening, the looser policy is still live. Retried on the next reload',
        );
    }
    for (const { name, reason } of report.postureUnverified) {
        log.warn(
            { event: 'config-reload', datasource: name, reason },
            `datasource "${name}" is SERVING but its read-only posture could not be established: ${reason}`,
        );
    }

    // Security event. NAMES ONLY — never a host, user, password or secret. `withheld` and
    // `postureUnverified` are reported separately because they mean opposite things about
    // availability (not serving vs. serving-but-unverified).
    log.warn(
        {
            event: 'config-reload',
            outcome: 'applied',
            added: report.added,
            changed: report.changed,
            removed: report.removed,
            withheld: report.withheld.map((w) => w.name),
            postureUnverified: report.postureUnverified.map((w) => w.name),
            retainedPrevious: report.retainedPrevious.map((w) => w.name),
            bootOnlyChanged: report.bootOnlyChanged,
            before: [...namesBefore],
            after: services.pools.names(),
        },
        `config reload applied — +${report.added.length} ~${report.changed.length} -${report.removed.length} ` +
            `withheld:${report.withheld.length} retainedPrevious:${report.retainedPrevious.length}`,
    );

    return report;
}
