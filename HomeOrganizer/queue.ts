/*
 * HomeOrganizer – throttled request queue
 * All API requests run one after another with a minimum interval, 429 -> wait for retry_after,
 * every job can be cancelled via a CancelToken. (based on ServerTools/queue.ts)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RestAPI } from "@webpack/common";

// ---------------------------------------------------------------- Intervals

/** Minimum intervals in ms - relationship changes are deliberately slower */
export const INTERVAL = {
    channel: 1000,
    profile: 1500,
    relationship: 1500
};

// ---------------------------------------------------------------- Cancelling

export class CancelledError extends Error {
    constructor() {
        super("Cancelled");
        this.name = "CancelledError";
    }
}

export const isCancelled = (e: unknown): e is CancelledError => e instanceof CancelledError;

export class CancelToken {
    cancelled = false;
    private listeners = new Set<() => void>();

    cancel() {
        if (this.cancelled) return;
        this.cancelled = true;
        for (const fn of this.listeners) {
            try { fn(); } catch { /* ignore */ }
        }
        this.listeners.clear();
        activeTokens.delete(this);
    }

    onCancel(fn: () => void) {
        if (this.cancelled) fn();
        else this.listeners.add(fn);
        return () => void this.listeners.delete(fn);
    }

    throwIfCancelled() {
        if (this.cancelled) throw new CancelledError();
    }
}

const activeTokens = new Set<CancelToken>();

export function createToken() {
    const token = new CancelToken();
    activeTokens.add(token);
    return token;
}

export function releaseToken(token: CancelToken) {
    activeTokens.delete(token);
}

/** Cancel all running jobs (stop()) */
export function cancelAll() {
    for (const token of [...activeTokens]) token.cancel();
}

export function sleep(ms: number, token?: CancelToken) {
    return new Promise<void>((resolve, reject) => {
        if (token?.cancelled) return reject(new CancelledError());
        let off = () => { };
        const timer = setTimeout(() => {
            off();
            resolve();
        }, Math.max(0, ms));
        if (token) off = token.onCancel(() => {
            clearTimeout(timer);
            reject(new CancelledError());
        });
    });
}

// ---------------------------------------------------------------- Queue

let chain: Promise<unknown> = Promise.resolve();
let lastRequest = 0;
let pausedUntil = 0;
let pending = 0;

const listeners = new Set<() => void>();
export const queueState = {
    get pending() { return pending; },
    get pausedUntil() { return pausedUntil; }
};
export function onQueueChange(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}
const emit = () => listeners.forEach(fn => fn());

function enqueue<T>(task: () => Promise<T>, interval: number, token?: CancelToken): Promise<T> {
    pending++;
    emit();

    const run = async () => {
        try {
            token?.throwIfCancelled();
            const wait = Math.max(lastRequest + interval, pausedUntil) - Date.now();
            if (wait > 0) await sleep(wait, token);
            token?.throwIfCancelled();
            lastRequest = Date.now();
            return await task();
        } finally {
            pending--;
            emit();
        }
    };

    const p = chain.then(run, run);
    chain = p.catch(() => { });
    return p;
}

// ---------------------------------------------------------------- API

export type Method = "get" | "put" | "del";

export class ApiError extends Error {
    constructor(public status: number, public code: number | undefined, message: string) {
        super(message);
        this.name = "ApiError";
    }
}

export interface ApiOptions {
    token?: CancelToken;
    interval?: number;
    onRateLimit?(seconds: number): void;
    /** Runs right before sending (inside the queue) */
    before?(): void;
}

/** Throttled RestAPI request. Returns the body, throws ApiError / CancelledError. */
export async function api<T = any>(method: Method, req: { url: string; query?: Record<string, any>; body?: any; }, opts: ApiOptions = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            const res = await enqueue(() => {
                opts.before?.();
                return RestAPI[method]({ ...req, retries: 0 } as any);
            }, opts.interval ?? INTERVAL.channel, opts.token);
            return res?.body as T;
        } catch (e: any) {
            if (isCancelled(e)) throw e;

            if (e?.status === 429 && attempt < 6) {
                const seconds = Math.min(Number(e.body?.retry_after ?? 5) || 5, 600);
                pausedUntil = Date.now() + seconds * 1000 + 300;
                emit();
                opts.onRateLimit?.(seconds);
                await sleep(seconds * 1000 + 300, opts.token);
                continue;
            }

            throw toApiError(e);
        }
    }
}

export function toApiError(e: any): ApiError {
    if (e instanceof ApiError) return e;
    const status = Number(e?.status ?? -1);
    return new ApiError(status, e?.body?.code, e?.body?.message ?? e?.message ?? "Unknown error");
}

/** Short description of an error for toasts */
export function describeError(e: unknown): string {
    if (isCancelled(e)) return "Cancelled";
    const err = toApiError(e);
    switch (err.status) {
        case 401: return "Not logged in (401)";
        case 403: return `No permission (403)${err.message ? ` - ${err.message}` : ""}`;
        case 404: return "Not found (404)";
        case -1: return err.message;
        default: return `Error ${err.status}: ${err.message}`;
    }
}
