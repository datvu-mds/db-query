/**
 * Typed errors that carry an HTTP status, so routes can map service failures to
 * the right response code without string-matching messages.
 */

export class BadRequestError extends Error {
    readonly status = 400;
    constructor(message: string) {
        super(message);
        this.name = 'BadRequestError';
    }
}

export class ForbiddenError extends Error {
    readonly status = 403;
    constructor(message: string) {
        super(message);
        this.name = 'ForbiddenError';
    }
}

export class ServiceUnavailableError extends Error {
    readonly status = 503;
    constructor(message: string) {
        super(message);
        this.name = 'ServiceUnavailableError';
    }
}

/** Extract a status from an error, defaulting to 500. */
export function statusOf(err: unknown): number {
    if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
        return (err as { status: number }).status;
    }
    return 500;
}
