/*
 * ServerTools – shared, throttled request queue
 * All API requests of all tools run one after another (base rate ~1/s), on 429 wait for retry_after,
 * every job can be cancelled via a CancelToken.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { RestAPI } from "@webpack/common";

const Native = VencordNative.pluginHelpers.ServerTools as PluginNative<typeof import("./native")>;

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

/** All running jobs - cancelled in stop() */
const activeTokens = new Set<CancelToken>();

export function createToken() {
    const token = new CancelToken();
    activeTokens.add(token);
    return token;
}

/** Job finished: stop tracking the token (without cancelling) */
export function releaseToken(token: CancelToken) {
    activeTokens.delete(token);
}

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

export const queueConfig = {
    /** Minimum interval between two API requests (ms) */
    interval: 1000
};

let chain: Promise<unknown> = Promise.resolve();
let lastRequest = 0;
/** On 429 the whole queue is paused until this point in time */
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

export interface QueueOptions {
    token?: CancelToken;
    /** Custom minimum interval, e.g. shorter for CDN downloads */
    interval?: number;
}

/** Runs the task once it is its turn and the minimum interval has been respected */
export function enqueue<T>(task: () => Promise<T>, { token, interval }: QueueOptions = {}): Promise<T> {
    pending++;
    emit();

    const run = async () => {
        try {
            token?.throwIfCancelled();
            const gap = interval ?? queueConfig.interval;
            const wait = Math.max(lastRequest + gap, pausedUntil) - Date.now();
            if (wait > 0) await sleep(wait, token);
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

export type Method = "get" | "post" | "patch" | "put" | "del";

export class ApiError extends Error {
    constructor(public status: number, public code: number | undefined, message: string, public body?: any) {
        super(message);
        this.name = "ApiError";
    }
}

export interface ApiOptions extends QueueOptions {
    /** Called on a rate limit with the wait time in seconds */
    onRateLimit?(seconds: number): void;
}

/** Throttled RestAPI request. Returns the body, throws ApiError / CancelledError. */
export async function api<T = any>(method: Method, req: { url: string; query?: Record<string, any>; body?: any; }, opts: ApiOptions = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            const res = await enqueue(() => RestAPI[method]({ ...req, retries: 0 } as any), opts);
            return res?.body as T;
        } catch (e: any) {
            if (isCancelled(e)) throw e;

            if (e?.status === 429 && attempt < 8) {
                const seconds = Math.min(Number(e.body?.retry_after ?? 5) || 5, 600);
                pausedUntil = Date.now() + seconds * 1000 + 300;
                emit();
                opts.onRateLimit?.(seconds);
                await sleep(seconds * 1000 + 300, opts.token);
                continue;
            }

            // Network error: retry once after a short delay
            if (e?.status == null && !(e instanceof ApiError) && attempt < 1) {
                await sleep(3000, opts.token);
                continue;
            }

            throw toApiError(e);
        }
    }
}

export function toApiError(e: any): ApiError {
    if (e instanceof ApiError) return e;
    const status = Number(e?.status ?? -1);
    const body = e?.body;
    const detail = formatErrorBody(body);
    const message = body?.message
        ? `${body.message}${detail ? ` (${detail})` : ""}`
        : e?.message ?? "Unknown error";
    return new ApiError(status, body?.code, message, body);
}

/** First field error message from Discord's nested "errors" structure */
function formatErrorBody(body: any): string {
    const walk = (node: any, path: string): string | null => {
        if (!node || typeof node !== "object") return null;
        if (Array.isArray(node._errors) && node._errors[0]?.message) return `${path}: ${node._errors[0].message}`;
        for (const [key, value] of Object.entries(node)) {
            const found = walk(value, path ? `${path}.${key}` : key);
            if (found) return found;
        }
        return null;
    };
    return walk(body?.errors, "") ?? "";
}

/** Short description of an error for toasts & logs */
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

// ---------------------------------------------------------------- CDN downloads

/**
 * Downloads a file from the Discord CDN (also via the queue, but with a shorter interval).
 * First in the renderer, on failure via the main process.
 */
export async function fetchBinary(url: string, token?: CancelToken): Promise<Uint8Array | null> {
    return enqueue(async () => {
        try {
            const res = await fetch(url);
            if (res.ok) return new Uint8Array(await res.arrayBuffer());
            if (res.status === 404) return null;
        } catch { /* CSP/CORS -> main process */ }

        try {
            const res = await Native.fetchCdn(url);
            return res.data ? new Uint8Array(res.data) : null;
        } catch {
            return null;
        }
    }, { token, interval: 150 });
}
