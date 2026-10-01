/*
 * LinkCards – Network: requests via the main process, global concurrency limit, backoff on 403/429
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";

import type { NativeResponse, RateLimit } from "./native";
import { HttpError, NotFoundError } from "./types";

const Native = VencordNative.pluginHelpers.LinkCards as PluginNative<typeof import("./native")>;
export const logger = new Logger("LinkCards");

const MAX_PARALLEL = 3;
const MIN_BACKOFF = 60_000;
const MAX_BACKOFF = 30 * 60_000;
/** 403 from these hosts means "blocked", not "rate limited" */
const BLOCKING_HOSTS = new Set(["www.reddit.com", "www.tikwm.com", "kick.com"]);

// ---------------------------------------------------------------- Concurrency limit

let active = 0;
const queue: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= MAX_PARALLEL) await new Promise<void>(r => queue.push(r));
    active++;
    try {
        return await fn();
    } finally {
        active--;
        queue.shift()?.();
    }
}

// ---------------------------------------------------------------- Backoff per host

interface Backoff {
    until: number;
    delay: number;
}

const backoffs = new Map<string, Backoff>();

export class BackoffError extends HttpError {
    constructor(public until: number) {
        super(429, "Rate limited");
    }
}

export function backoffUntil(host: string) {
    const b = backoffs.get(host);
    return b && b.until > Date.now() ? b.until : 0;
}

function applyBackoff(host: string, res: NativeResponse) {
    const prev = backoffs.get(host);
    const delay = Math.min(prev ? prev.delay * 2 : MIN_BACKOFF, MAX_BACKOFF);
    let until = Date.now() + delay;

    if (res.retryAfter) until = Date.now() + res.retryAfter * 1000;
    else if (res.rateLimit?.remaining === 0 && res.rateLimit.reset > Date.now()) until = res.rateLimit.reset + 1000;

    backoffs.set(host, { until, delay });
    return until;
}

export function resetBackoffs() {
    backoffs.clear();
}

// ---------------------------------------------------------------- GitHub rate limit

let githubRate: RateLimit | null = null;
const rateListeners = new Set<() => void>();

export const getGitHubRate = () => githubRate;

export function setGitHubRate(rate: RateLimit | null | undefined) {
    if (!rate) return;
    githubRate = rate;
    rateListeners.forEach(l => l());
}

export function onGitHubRate(listener: () => void) {
    rateListeners.add(listener);
    return () => void rateListeners.delete(listener);
}

export async function refreshGitHubRate() {
    const res = await Native.getGitHubRateLimit();
    setGitHubRate(res.rateLimit);
    return res;
}

// ---------------------------------------------------------------- Request

/**
 * Load JSON from an allowed API.
 * @param allow404 return null on 404 instead of throwing
 * @param body sent as JSON POST (only allowed for a few hosts, see native.ts)
 */
export async function api<T = any>(url: string, allow404 = false, body?: unknown): Promise<T> {
    const { host } = new URL(url);

    const until = backoffUntil(host);
    if (until) throw new BackoffError(until);

    const res = await withSlot(() => Native.request(url, body === undefined ? undefined : JSON.stringify(body)));

    if (host === "api.github.com") setGitHubRate(res.rateLimit);

    if (res.status === 403 || res.status === 429) {
        // GitHub also responds with 403 on missing permissions – it is only a rate limit if the quota is exhausted or Retry-After is set
        // Hosts behind bot protection answer 403 when blocked – no backoff, so fallbacks on the same host still work
        const isRateLimit = res.status === 429 || res.retryAfter != null || res.rateLimit?.remaining === 0 || (host !== "api.github.com" && !BLOCKING_HOSTS.has(host));
        if (isRateLimit) {
            const until = applyBackoff(host, res);
            logger.warn(`Rate limited on ${host}, next attempt ${new Date(until).toLocaleTimeString()}`);
            throw new BackoffError(until);
        }
        throw new HttpError(403, "No access");
    }

    if (res.status === 404) {
        if (allow404) return null as T;
        throw new NotFoundError();
    }

    if (res.status === 401) throw new HttpError(401, host === "api.github.com" ? "Invalid GitHub token" : "No access");
    if (res.status < 200 || res.status >= 300 || res.error) {
        throw new HttpError(res.status, res.error ?? `HTTP ${res.status}`);
    }

    backoffs.delete(host);
    return res.data as T;
}
