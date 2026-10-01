/*
 * LinkCards – runs in the Electron main process
 * Discord's CSP blocks fetch() in the renderer, so all API requests run here.
 * Only hardcoded hosts and paths – not a general proxy.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { IpcMainInvokeEvent } from "electron";

const USER_AGENT = "Vencord-LinkCards (+https://github.com/Vendicated/Vencord)";
const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT = 15_000;

/** Allowed hosts with allowed path prefixes */
const ALLOWED: Record<string, string[]> = {
    "api.github.com": ["/repos/", "/rate_limit"],
    "store.steampowered.com": ["/api/appdetails", "/appreviews/"],
    "registry.npmjs.org": ["/"],
    "api.npmjs.org": ["/downloads/point/"],
    "pypi.org": ["/pypi/"],
    "crates.io": ["/api/v1/crates/"],
    "discord.com": ["/api/v10/invites/"],
    "www.youtube.com": ["/oembed"],
    "returnyoutubedislikeapi.com": ["/votes"],
    "gql.twitch.tv": ["/gql"],
    "kick.com": ["/api/v2/channels/"],
    "api.fxtwitter.com": ["/"],
    "www.reddit.com": ["/by_id/", "/r/", "/user/", "/oembed"],
    "www.tikwm.com": ["/api/"],
    "www.tiktok.com": ["/oembed"],
    "apis.roblox.com": ["/universes/v1/places/"],
    "games.roblox.com": ["/v1/games"],
    "api.modrinth.com": ["/v2/project/"],
    "public.api.bsky.app": ["/xrpc/app.bsky.feed.getPostThread", "/xrpc/app.bsky.actor.getProfile"]
};

/** Language subdomains (en.wikipedia.org, de.wikipedia.org, ...) */
const WIKIPEDIA = /^[a-z][a-z-]{1,11}\.wikipedia\.org$/;
const WIKIPEDIA_PATHS = ["/api/rest_v1/page/summary/"];

/** Only these hosts may receive a POST body */
const POST_HOSTS = new Set(["gql.twitch.tv"]);

/** Public client id of the Twitch website */
const TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

export interface RateLimit {
    limit: number;
    remaining: number;
    /** Unix time in ms */
    reset: number;
}

export interface NativeResponse {
    status: number;
    data: any;
    error?: string;
    /** Seconds from Retry-After */
    retryAfter?: number;
    rateLimit?: RateLimit;
}

function githubToken(): string {
    const token = RendererSettings.store.plugins?.LinkCards?.githubToken;
    return typeof token === "string" ? token.trim() : "";
}

function checkUrl(raw: string): URL | null {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const prefixes = ALLOWED[url.hostname] ?? (WIKIPEDIA.test(url.hostname) ? WIKIPEDIA_PATHS : undefined);
    if (!prefixes?.some(p => url.pathname.startsWith(p))) return null;
    return url;
}

function readRateLimit(headers: Headers): RateLimit | undefined {
    const limit = headers.get("x-ratelimit-limit");
    const remaining = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset");
    if (limit == null || remaining == null || reset == null) return undefined;
    return { limit: Number(limit), remaining: Number(remaining), reset: Number(reset) * 1000 };
}

/** GET (or POST with JSON body, only for POST_HOSTS) request to an allowed API, response as JSON */
export async function request(_: IpcMainInvokeEvent, rawUrl: string, body?: string): Promise<NativeResponse> {
    const url = checkUrl(rawUrl);
    if (!url) return { status: -1, data: null, error: "URL not allowed" };
    if (body != null && (typeof body !== "string" || !POST_HOSTS.has(url.hostname))) return { status: -1, data: null, error: "POST not allowed" };

    const headers: Record<string, string> = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json"
    };

    if (url.hostname === "gql.twitch.tv") headers["Client-Id"] = TWITCH_CLIENT_ID;
    if (body != null) headers["Content-Type"] = "application/json";

    // Token is only sent to api.github.com
    if (url.hostname === "api.github.com") {
        headers.Accept = "application/vnd.github+json";
        headers["X-GitHub-Api-Version"] = "2022-11-28";
        const token = githubToken();
        if (token) headers.Authorization = `Bearer ${token}`;
    }

    try {
        const res = await fetch(url, {
            method: body != null ? "POST" : "GET",
            body,
            headers,
            redirect: "follow",
            credentials: "omit",
            signal: AbortSignal.timeout(TIMEOUT)
        });

        // Do not accept redirects to other hosts
        if (res.url && !checkUrl(res.url)) return { status: -1, data: null, error: "Redirect not allowed" };

        const retry = res.headers.get("retry-after");
        const base: NativeResponse = {
            status: res.status,
            data: null,
            retryAfter: retry && /^\d+$/.test(retry) ? Number(retry) : undefined,
            rateLimit: url.hostname === "api.github.com" ? readRateLimit(res.headers) : undefined
        };

        const length = Number(res.headers.get("content-length") ?? 0);
        if (length > MAX_BYTES) return { ...base, error: "Response too large" };

        const text = await res.text();
        if (text.length > MAX_BYTES) return { ...base, error: "Response too large" };

        try {
            base.data = text ? JSON.parse(text) : null;
        } catch {
            base.error = "Invalid response";
        }
        return base;
    } catch (e) {
        return { status: -1, data: null, error: String((e as Error)?.message ?? e) };
    }
}

/** Current GitHub rate limit (does not count against the limit itself) */
export async function getGitHubRateLimit(_: IpcMainInvokeEvent) {
    const res = await request(_, "https://api.github.com/rate_limit");
    const core = res.data?.resources?.core;
    return {
        status: res.status,
        error: res.error,
        hasToken: !!githubToken(),
        rateLimit: core
            ? { limit: core.limit, remaining: core.remaining, reset: core.reset * 1000 } as RateLimit
            : res.rateLimit
    };
}
