/*
 * Wrapped – local statistics data, aggregated per day
 * Recorded from installation on and stored locally in the DataStore only.
 * Kept in memory and flushed periodically – never written on every event.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

export const logger = new Logger("Wrapped");

const KEY = "Wrapped_stats";
/** Days older than this are dropped */
export const KEEP_DAYS = 366;

export type Counter = Record<string, number>;

/** Everything recorded on one (local) calendar day. Times in seconds. */
export interface DayStats {
    /** Messages sent */
    messages?: number;
    /** Characters typed in sent messages */
    chars?: number;
    /** Seconds in voice */
    voice?: number;
    /** Seconds Discord was focused and you were not idle */
    active?: number;
    /** Per hour of day (0–23) */
    msgHours?: number[];
    voiceHours?: number[];
    activeHours?: number[];
    /** Messages per server id, "@me" = all DMs and group DMs */
    msgPlaces?: Counter;
    /** Messages per channel id */
    msgChannels?: Counter;
    /** DM messages you sent per recipient user id */
    dmSent?: Counter;
    /** DM messages you received per author user id */
    dmReceived?: Counter;
    /** Voice seconds per server id ("@me" = calls) */
    voicePlaces?: Counter;
    /** Voice seconds per channel id */
    voiceChannels?: Counter;
    /** Voice seconds spent together with each user id */
    voiceWith?: Counter;
    /** Seconds per game name */
    games?: Counter;
}

export interface StatsData {
    version: 1;
    /** Start of tracking (ms) */
    since: number;
    /** "YYYY-MM-DD" (local time) → stats */
    days: Record<string, DayStats>;
    /** Name cache for users, servers and channels (so stats survive leaving) */
    names: Record<string, string>;
}

const empty = (): StatsData => ({ version: 1, since: Date.now(), days: {}, names: {} });

// ---------------------------------------------------------------- State

let data: StatsData = empty();
let loaded = false;
let dirty = false;

const listeners = new Set<() => void>();
export function onStatsChange(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}
let emitTimer: ReturnType<typeof setTimeout> | undefined;
/** Notify open dashboards, at most every 2 s */
function emit(now = false) {
    if (now) {
        clearTimeout(emitTimer);
        emitTimer = undefined;
    } else if (emitTimer) return;
    const run = () => {
        emitTimer = undefined;
        listeners.forEach(fn => {
            try { fn(); } catch { /* ignore */ }
        });
    };
    if (now) run();
    else emitTimer = setTimeout(run, 2000);
}

export const getStats = () => data;
export const isLoaded = () => loaded;

// ---------------------------------------------------------------- Days

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDayKey(key: string) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d);
}

export function today(): DayStats {
    return data.days[dayKey()] ??= {};
}

function prune() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
    const min = dayKey(cutoff);
    for (const key of Object.keys(data.days))
        if (key < min) delete data.days[key];
}

// ---------------------------------------------------------------- Mutation helpers

export function add(day: DayStats, field: "messages" | "chars" | "voice" | "active", amount: number) {
    day[field] = (day[field] ?? 0) + amount;
    markDirty();
}

export function addHour(day: DayStats, field: "msgHours" | "voiceHours" | "activeHours", hour: number, amount: number) {
    const arr = day[field] ??= new Array(24).fill(0);
    arr[hour] = (arr[hour] ?? 0) + amount;
    markDirty();
}

type CounterField = Exclude<{ [K in keyof DayStats]-?: DayStats[K] extends Counter | undefined ? K : never }[keyof DayStats], undefined>;

export function count(day: DayStats, field: CounterField, id: string, amount: number) {
    const c = (day[field] ??= {}) as Counter;
    c[id] = (c[id] ?? 0) + amount;
    markDirty();
}

export function rememberName(id: string, name: string | null | undefined) {
    if (!id || !name || data.names[id] === name) return;
    data.names[id] = name;
    markDirty();
}

function markDirty() {
    dirty = true;
    emit();
}

// ---------------------------------------------------------------- Loading & saving

/** Adds b into a (numbers summed, arrays element-wise, objects recursively) */
function mergeInto(a: any, b: any) {
    for (const [k, v] of Object.entries(b)) {
        if (typeof v === "number") a[k] = (a[k] ?? 0) + v;
        else if (Array.isArray(v)) {
            const arr: number[] = a[k] ??= new Array(v.length).fill(0);
            v.forEach((n, i) => arr[i] = (arr[i] ?? 0) + n);
        } else if (v && typeof v === "object") mergeInto(a[k] ??= {}, v);
    }
}

export async function loadStats() {
    try {
        const stored = await DataStore.get<StatsData>(KEY);
        if (stored?.days) {
            // Keep what was recorded before loading finished
            const merged: StatsData = { version: 1, since: stored.since ?? data.since, days: stored.days, names: { ...stored.names, ...data.names } };
            for (const [key, day] of Object.entries(data.days))
                mergeInto(merged.days[key] ??= {}, day);
            data = merged;
        } else {
            dirty = true;
        }
    } catch (e) {
        logger.error("Statistics could not be loaded", e);
    }
    loaded = true;
    prune();
    emit(true);
}

export async function flushStats() {
    if (!dirty || !loaded) return;
    dirty = false;
    prune();
    try {
        await DataStore.set(KEY, data);
    } catch (e) {
        dirty = true;
        logger.error("Statistics could not be saved", e);
    }
}

/** Delete everything, tracking starts over */
export async function resetStats() {
    data = empty();
    dirty = true;
    await flushStats();
    emit(true);
}

export function exportJson(extra?: unknown) {
    return JSON.stringify({ exportedAt: new Date().toISOString(), stats: data, allTime: extra }, null, 2);
}
