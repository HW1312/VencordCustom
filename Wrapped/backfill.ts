/*
 * Wrapped – "Count my messages": all-time message counts via Discord's search API
 * One request after another with a pause in between; 429 → wait retry_after, 202 (index not ready) → retry later.
 * Results are cached in the DataStore and shown separately from the tracked stats.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { ChannelStore, GuildStore, RestAPI, UserStore } from "@webpack/common";

import { logger } from "./store";
import { userName } from "./tracker";

const KEY = "Wrapped_allTime";
/** Pause between two search requests (ms) – search is heavily rate limited */
const DELAY = 1500;
/** Most recent DMs to count */
const MAX_DMS = 25;

export interface AllTimeEntry {
    id: string;
    name: string;
    /** Messages by you */
    mine: number;
    /** All messages in the DM (you + them), DMs only */
    total?: number;
    /** DM recipient */
    userId?: string;
    error?: string;
}

export interface AllTimeData {
    /** When the count finished (ms) */
    at: number;
    guilds: AllTimeEntry[];
    dms: AllTimeEntry[];
}

export interface BackfillState {
    running: boolean;
    done: number;
    total: number;
    label: string;
    /** Seconds we are waiting for a rate limit */
    waiting: number;
    error: string | null;
    result: AllTimeData | null;
}

const state: BackfillState = { running: false, done: 0, total: 0, label: "", waiting: 0, error: null, result: null };
let cancelled = false;
let wake: (() => void) | null = null;

const listeners = new Set<() => void>();
export function onBackfillChange(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}
function emit() {
    listeners.forEach(fn => {
        try { fn(); } catch { /* ignore */ }
    });
}

export const getBackfill = () => state;

export async function loadAllTime() {
    try {
        state.result = await DataStore.get<AllTimeData>(KEY) ?? null;
        emit();
    } catch (e) {
        logger.error("All-time counts could not be loaded", e);
    }
}

export async function clearAllTime() {
    state.result = null;
    await DataStore.del(KEY);
    emit();
}

function sleep(ms: number) {
    return new Promise<void>(resolve => {
        if (cancelled) return resolve();
        const t = setTimeout(resolve, ms);
        wake = () => { clearTimeout(t); resolve(); };
    });
}

/** One search request → total_results. Handles 429 and 202 (index not ready yet). */
async function searchCount(url: string, query: Record<string, string>): Promise<number> {
    for (let attempt = 0; attempt < 8 && !cancelled; attempt++) {
        let res: any;
        try {
            res = await RestAPI.get({ url, query, retries: 1 } as any);
        } catch (e: any) {
            if (e?.status === 429) {
                const secs = Math.min(Number(e.body?.retry_after ?? 5) || 5, 300);
                state.waiting = Math.ceil(secs);
                emit();
                await sleep(secs * 1000 + 250);
                state.waiting = 0;
                emit();
                continue;
            }
            throw e;
        }
        // 202: the search index for this server/channel is still being built
        if (res?.status === 202 || res?.body?.code === 110000) {
            const secs = Math.min(Number(res.body?.retry_after ?? 3) || 3, 60);
            state.waiting = Math.ceil(secs);
            emit();
            await sleep(secs * 1000 + 500);
            state.waiting = 0;
            emit();
            continue;
        }
        return Number(res?.body?.total_results ?? 0);
    }
    throw new Error(cancelled ? "Cancelled" : "Search index not ready");
}

const describe = (e: any) =>
    e?.status === 403 ? "No permission" : e?.body?.message ?? e?.message ?? "Error";

export async function runBackfill() {
    if (state.running) return;
    const me = UserStore.getCurrentUser()?.id;
    if (!me) return;

    cancelled = false;
    const guilds = Object.values(GuildStore.getGuilds());
    const dms = ChannelStore.getSortedPrivateChannels()
        .filter(c => c.type === 1 && c.recipients?.length)
        .slice(0, MAX_DMS);

    Object.assign(state, { running: true, done: 0, total: guilds.length + dms.length, label: "", waiting: 0, error: null });
    emit();

    const result: AllTimeData = { at: 0, guilds: [], dms: [] };
    try {
        for (const g of guilds) {
            if (cancelled) break;
            state.label = g.name;
            emit();
            const entry: AllTimeEntry = { id: g.id, name: g.name, mine: 0 };
            try {
                entry.mine = await searchCount(`/guilds/${g.id}/messages/search`, { author_id: me, include_nsfw: "true" });
            } catch (e) {
                entry.error = describe(e);
            }
            result.guilds.push(entry);
            state.done++;
            emit();
            await sleep(DELAY);
        }

        for (const c of dms) {
            if (cancelled) break;
            const uid = c.recipients[0];
            const name = userName(UserStore.getUser(uid)) ?? c.name ?? uid;
            state.label = "@" + name;
            emit();
            const entry: AllTimeEntry = { id: c.id, name, mine: 0, total: 0, userId: uid };
            try {
                entry.mine = await searchCount(`/channels/${c.id}/messages/search`, { author_id: me });
                await sleep(DELAY);
                if (!cancelled) entry.total = await searchCount(`/channels/${c.id}/messages/search`, {});
            } catch (e) {
                entry.error = describe(e);
            }
            result.dms.push(entry);
            state.done++;
            emit();
            await sleep(DELAY);
        }

        if (!cancelled) {
            result.at = Date.now();
            result.guilds.sort((a, b) => b.mine - a.mine);
            result.dms.sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
            state.result = result;
            await DataStore.set(KEY, result);
        }
    } catch (e: any) {
        logger.error("Counting failed", e);
        state.error = describe(e);
    } finally {
        state.running = false;
        state.label = "";
        state.waiting = 0;
        emit();
    }
}

export function cancelBackfill() {
    cancelled = true;
    wake?.();
    emit();
}
