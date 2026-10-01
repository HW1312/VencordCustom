/*
 * RamSaver – shared state (current usage, history, last cleanup)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useForceUpdater } from "@utils/react";
import { PluginNative } from "@utils/types";
import { useEffect } from "@webpack/common";

import type { Usage } from "./native";

const Native = VencordNative.pluginHelpers.RamSaver as PluginNative<typeof import("./native")>;

const HISTORY_LENGTH = 120;
const SLOW_POLL = 5000;
const FAST_POLL = 1500;

export interface TrimResult {
    time: number;
    before: number;
    after: number;
    channels: number;
}

export const state = {
    usage: null as Usage | null,
    /** RAM history in MB */
    history: [] as number[],
    lastTrim: null as TrimResult | null,
    trimming: false
};

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let fastPollers = 0;
let polling = false;

export function emitChange() {
    listeners.forEach(l => l());
}

let inFlight = false;

async function poll() {
    clearTimeout(timer);
    if (inFlight) return;
    inFlight = true;

    try {
        const usage = await Native.getUsage();
        if (polling) {
            state.usage = usage;
            state.history.push(usage.memoryMB);
            if (state.history.length > HISTORY_LENGTH) state.history.shift();
            emitChange();
        }
    } catch { } finally {
        inFlight = false;
    }

    if (polling) timer = setTimeout(poll, fastPollers > 0 ? FAST_POLL : SLOW_POLL);
}

export function startPolling() {
    if (polling) return;
    polling = true;
    poll();
}

export function stopPolling() {
    polling = false;
    clearTimeout(timer);
    state.history = [];
    state.usage = null;
}

/** React hook: re-renders on every change. `fast` = update faster while the component is visible. */
export function useRamSaverState(fast = false) {
    const forceUpdate = useForceUpdater();

    useEffect(() => {
        listeners.add(forceUpdate);
        if (fast) {
            fastPollers++;
            if (polling) poll();
        }
        return () => {
            listeners.delete(forceUpdate);
            if (fast) fastPollers--;
        };
    }, []);

    return state;
}
