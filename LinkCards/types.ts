/*
 * LinkCards – shared types & formatting
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// ---------------------------------------------------------------- Provider

export type ProviderId =
    | "github" | "steam" | "npm" | "pypi" | "crates"
    | "discord" | "youtube" | "twitch" | "kick" | "twitter" | "reddit" | "tiktok"
    | "bluesky" | "wikipedia" | "roblox" | "modrinth" | "google";

export interface Target {
    /** Unique cache key within the provider */
    id: string;
    /** Original link from the message */
    url: string;
}

export interface Provider<T extends Target = any, D = any> {
    id: ProviderId;
    label: string;
    /** Short description for the settings */
    hint: string;
    /** Card is built from the link alone (no request) – no live status / refresh button */
    static?: boolean;
    /** How long data counts as fresh (ms) */
    ttl: number;
    /** Detect link – null if not responsible */
    match(url: URL): T | null;
    fetch(target: T): Promise<D>;
    render(data: D, target: T): CardView;
}

// ---------------------------------------------------------------- Card view

export interface IconDef {
    path: string;
    /** Default: 0 0 24 24 */
    viewBox?: string;
}

export interface Stat {
    icon?: IconDef;
    value: string;
    title?: string;
    /** Color dot instead of icon (e.g. programming language) */
    dot?: string;
}

export interface CardView {
    /** Color of the left bar and the status icon */
    color: string;
    provider: string;
    context?: string;
    icon?: IconDef;
    title: string;
    titleSuffix?: string;
    url: string;
    badge?: string;
    /** Falsy entries are skipped */
    meta?: (string | null | undefined | false | 0)[];
    description?: string;
    labels?: { name: string; color: string; }[];
    stats?: Stat[];
    price?: { final: string; initial?: string; discount?: number; };
}

// ---------------------------------------------------------------- Errors

export class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

export class NotFoundError extends HttpError {
    constructor() {
        super(404, "Not found");
    }
}

// ---------------------------------------------------------------- Formatting

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en-US");

/** "3 hr. ago" / "2 days ago" */
export function timeAgo(date: string | number | Date | null | undefined): string {
    if (date == null) return "";
    const ms = new Date(date).getTime();
    if (!Number.isFinite(ms)) return "";
    const diff = (ms - Date.now()) / 1000;
    const abs = Math.abs(diff);

    if (abs < 45) return "just now";
    if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
    if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
    if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), "month");
    return rtf.format(Math.round(diff / (86400 * 365)), "year");
}

export function formatDate(date: string | number | Date | null | undefined): string {
    if (date == null) return "";
    const d = new Date(date);
    return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
}

export const formatCompact = (n: number | null | undefined) => n == null ? "–" : compact.format(n);
export const formatNumber = (n: number | null | undefined) => n == null ? "–" : full.format(n);

/** Path segments without empty entries, decoded */
export function segments(url: URL): string[] {
    return url.pathname.split("/").filter(Boolean).map(s => {
        try {
            return decodeURIComponent(s);
        } catch {
            return s;
        }
    });
}

/** Cut text to max characters at a word boundary */
export function truncate(text: string | null | undefined, max = 300): string | undefined {
    if (!text) return undefined;
    const t = text.trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const space = cut.lastIndexOf(" ");
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Duration since a date as "2h 15m" */
export function duration(since: string | number | null | undefined): string {
    if (since == null) return "";
    const ms = Date.now() - new Date(since).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "";
    const min = Math.floor(ms / 60_000);
    return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

export const hostIs =(url: URL, ...hosts: string[]) => hosts.includes(url.hostname.toLowerCase());
