/*
 * LinkCards – all providers & link detection
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "../index";
import { Provider, Target } from "../types";
import { bluesky } from "./bluesky";
import { crates } from "./crates";
import { discord } from "./discord";
import { github } from "./github";
import { google } from "./google";
import { kick } from "./kick";
import { modrinth } from "./modrinth";
import { npm } from "./npm";
import { pypi } from "./pypi";
import { reddit } from "./reddit";
import { roblox } from "./roblox";
import { steam } from "./steam";
import { tiktok } from "./tiktok";
import { twitch } from "./twitch";
import { twitter } from "./twitter";
import { wikipedia } from "./wikipedia";
import { youtube } from "./youtube";

export const PROVIDERS: Provider[] = [
    discord, youtube, twitch, kick, twitter, reddit, tiktok, bluesky,
    github, steam, roblox, npm, pypi, crates, modrinth, wikipedia, google
];

export const MAX_CARDS = 3;

export interface Match {
    provider: Provider;
    target: Target;
    key: string;
}

const isEnabled = (p: Provider) => settings.store[p.id] !== false;

export function matchUrl(raw: string): Match | null {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    for (const provider of PROVIDERS) {
        if (!isEnabled(provider)) continue;
        const target = provider.match(url);
        if (target) return { provider, target, key: `${provider.id}:${target.id}` };
    }
    return null;
}

// ---------------------------------------------------------------- Links from messages

const URL_RE = /https?:\/\/[^\s<>"'`|]+/gi;
const TRAILING = /[).,!?:;*_~\]>]+$/;

const memo = new Map<string, Match[]>();

/** Up to MAX_CARDS supported links, without duplicates */
export function findMatches(content: string | undefined): Match[] {
    if (!content || !content.includes("http")) return [];

    // Key includes settings that affect the result
    const memoKey = `${PROVIDERS.map(p => isEnabled(p) ? 1 : 0).join("")}${settings.store.steamCountry}|${content}`;
    const cached = memo.get(memoKey);
    if (cached) return cached;

    const result: Match[] = [];
    const seen = new Set<string>();

    for (const [raw] of content.matchAll(URL_RE)) {
        // Strip brackets from markdown links [text](url) and trailing punctuation
        const url = raw.replace(TRAILING, "");
        const m = matchUrl(url);
        if (!m || seen.has(m.key)) continue;
        seen.add(m.key);
        result.push(m);
        if (result.length >= MAX_CARDS) break;
    }

    if (memo.size > 500) memo.clear();
    memo.set(memoKey, result);
    return result;
}

export const clearMatchMemo = () => memo.clear();
