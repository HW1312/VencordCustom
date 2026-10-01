/*
 * ServerDeclutter – local activity data (last opened / last written)
 * Only recorded since installation and stored locally in the DataStore only.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

const logger = new Logger("ServerDeclutter");
const KEY = "ServerDeclutter_activity";

export interface GuildActivity {
    /** Last opened (ms) */
    opened?: number;
    /** Last written by you (ms) */
    wrote?: number;
}

export interface ActivityData {
    /** Start of tracking (ms) */
    since: number;
    guilds: Record<string, GuildActivity>;
}

// ---------------------------------------------------------------- State

let data: ActivityData = { since: Date.now(), guilds: {} };
let loaded = false;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const listeners = new Set<() => void>();
export function onActivityChange(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}
const emit = () => listeners.forEach(fn => {
    try { fn(); } catch { /* ignore */ }
});

export const getActivity = () => data;
export const isLoaded = () => loaded;

// ---------------------------------------------------------------- Loading & saving

export async function loadActivity() {
    try {
        const stored = await DataStore.get<ActivityData>(KEY);
        if (stored?.guilds) {
            // Keep events recorded before loading (whichever value is newer)
            const merged: ActivityData = { since: stored.since ?? data.since, guilds: { ...stored.guilds } };
            for (const [id, a] of Object.entries(data.guilds)) {
                const old = merged.guilds[id] ?? {};
                merged.guilds[id] = {
                    opened: Math.max(old.opened ?? 0, a.opened ?? 0) || undefined,
                    wrote: Math.max(old.wrote ?? 0, a.wrote ?? 0) || undefined
                };
            }
            data = merged;
        } else {
            dirty = true;
        }
    } catch (e) {
        logger.error("Activity data could not be loaded", e);
    }
    loaded = true;
    if (dirty) scheduleSave();
    emit();
}

function scheduleSave() {
    dirty = true;
    if (saveTimer || !loaded) return;
    saveTimer = setTimeout(() => {
        saveTimer = undefined;
        void flushActivity();
    }, 5000);
}

export async function flushActivity() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!dirty || !loaded) return;
    dirty = false;
    try {
        await DataStore.set(KEY, data);
    } catch (e) {
        dirty = true;
        logger.error("Activity data could not be saved", e);
    }
}

// ---------------------------------------------------------------- Recording

export function recordOpened(guildId: string) {
    const g = data.guilds[guildId] ??= {};
    const now = Date.now();
    // Do not save again on every channel switch
    if (g.opened && now - g.opened < 60_000) return;
    g.opened = now;
    scheduleSave();
    emit();
}

export function recordWrote(guildId: string) {
    const g = data.guilds[guildId] ??= {};
    const now = Date.now();
    g.wrote = now;
    g.opened = Math.max(g.opened ?? 0, now);
    scheduleSave();
    emit();
}

/** Delete everything, tracking starts over */
export async function resetActivity() {
    data = { since: Date.now(), guilds: {} };
    dirty = true;
    await flushActivity();
    emit();
}
