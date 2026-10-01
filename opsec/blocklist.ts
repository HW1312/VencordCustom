/*
 * OpSec – Online blocklist of known scam/phishing domains (ScamShield)
 * Source: github.com/Discord-AntiScam/scam-links (fetched in the main process, see native.ts).
 * Cached in the DataStore and reloaded at most every 12 hours. Errors stay silent.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";

import { setBlocklist } from "./links";

const Native = VencordNative.pluginHelpers.OpSec as PluginNative<typeof import("./native")>;
const logger = new Logger("OpSec");

export const BLOCKLIST_SOURCE = "Discord-AntiScam/scam-links";

const CACHE_KEY = "OpSec_scamBlocklist";
const MAX_AGE = 12 * 60 * 60 * 1000;
const CHECK_EVERY = 60 * 60 * 1000;

interface Cache {
    updated: number;
    domains: string[];
}

export interface BlocklistStatus {
    enabled: boolean;
    count: number;
    /** Time of the last successful update (0 = never) */
    updated: number;
    loading: boolean;
    /** Last manual attempt failed */
    failed: boolean;
}

const status: BlocklistStatus = { enabled: false, count: 0, updated: 0, loading: false, failed: false };
const listeners = new Set<() => void>();
let domains: Set<string> | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let onLoaded: (() => void) | null = null;

export const getBlocklistStatus = (): BlocklistStatus => ({ ...status });

export function onBlocklistChange(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

function emit() {
    listeners.forEach(l => l());
}

/** One line per domain; comments, wildcards (*), paths etc. are skipped */
function parse(text: string) {
    const out: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const d = line.trim().toLowerCase().replace(/\.$/, "");
        if (d && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) out.push(d);
    }
    return out;
}

function use(list: string[], updated: number) {
    domains = new Set(list);
    status.count = domains.size;
    status.updated = updated;
    if (status.enabled) {
        setBlocklist(domains);
        onLoaded?.();
    }
    emit();
}

/** Reload the list. Without `force` only if it is older than 12 hours. */
export async function refreshBlocklist(force = false) {
    if (status.loading) return false;
    if (!force && status.updated && Date.now() - status.updated < MAX_AGE) return true;

    status.loading = true;
    status.failed = false;
    emit();
    try {
        const text = await Native.fetchScamBlocklist();
        const list = text ? parse(text) : [];
        // An empty or tiny list is almost certainly an error page – keep the old list
        if (list.length < 100) throw new Error(`Unusable list (${list.length} entries)`);

        const updated = Date.now();
        await DataStore.set(CACHE_KEY, { updated, domains: list } satisfies Cache);
        use(list, updated);
        return true;
    } catch (e) {
        logger.warn("Failed to load scam blocklist", e);
        status.failed = true;
        return false;
    } finally {
        status.loading = false;
        emit();
    }
}

/**
 * Enable/disable the blocklist. `loaded` is called as soon as new domains are active
 * (so that links already on screen can be marked retroactively).
 */
export async function setBlocklistEnabled(on: boolean, loaded?: () => void) {
    if (on === status.enabled) return;
    status.enabled = on;
    onLoaded = on ? loaded ?? null : null;
    clearInterval(timer);
    timer = undefined;

    if (!on) {
        setBlocklist(null);
        emit();
        return;
    }

    if (!domains) {
        try {
            const cache = await DataStore.get<Cache>(CACHE_KEY);
            if (cache?.domains?.length && status.enabled) use(cache.domains, cache.updated ?? 0);
        } catch (e) {
            logger.warn("Failed to read cached blocklist", e);
        }
    } else {
        setBlocklist(domains);
        onLoaded?.();
        emit();
    }
    if (!status.enabled) return;

    refreshBlocklist();
    // Discord often runs for days – check hourly whether 12 hours have passed
    timer = setInterval(() => refreshBlocklist(), CHECK_EVERY);
}
