/*
 * LinkCards – Cache: memory + DataStore with per-provider TTL, identical requests are merged
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { BackoffError, logger } from "./net";
import { HttpError, Provider, Target } from "./types";

/** Entries that have not been updated for a long time are removed on startup */
const MAX_AGE = 7 * 24 * 60 * 60_000;
/** Errors (e.g. 404) are remembered for a shorter time */
const ERROR_TTL = 5 * 60_000;

export interface CacheEntry {
    data?: any;
    /** Time of the last successful refresh */
    fetchedAt?: number;
    error?: string;
    errorAt?: number;
    /** Rate limited until (ms) */
    backoffUntil?: number;
    notFound?: boolean;
}

let store: DataStore.UseStore | null = null;
const getStore = () => store ??= DataStore.createStore("VencordLinkCards", "cache");

const memory = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<void>>();
const loadedFromDisk = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

export const cacheKey = (provider: Provider, target: Target) => `${provider.id}:${target.id}`;

// ---------------------------------------------------------------- Subscribing

export function subscribe(key: string, listener: () => void) {
    let set = listeners.get(key);
    if (!set) listeners.set(key, set = new Set());
    set.add(listener);
    return () => {
        set!.delete(listener);
        if (!set!.size) listeners.delete(key);
    };
}

function emit(key: string) {
    listeners.get(key)?.forEach(l => l());
}

// ---------------------------------------------------------------- Reading

export const getEntry = (key: string) => memory.get(key);

export const hasData = (key: string) => memory.get(key)?.data != null;

export function isFresh(provider: Provider, entry: CacheEntry | undefined) {
    if (!entry) return false;
    const now = Date.now();
    if (entry.backoffUntil && entry.backoffUntil > now) return true;
    if (entry.errorAt && (!entry.fetchedAt || entry.errorAt > entry.fetchedAt)) return now - entry.errorAt < Math.min(ERROR_TTL, provider.ttl);
    return entry.fetchedAt != null && now - entry.fetchedAt < provider.ttl;
}

export const isLoading = (key: string) => inflight.has(key);

async function loadFromDisk(key: string) {
    if (loadedFromDisk.has(key)) return;
    loadedFromDisk.add(key);
    try {
        const entry = await DataStore.get<CacheEntry>(key, getStore());
        if (entry?.data != null && !memory.get(key)?.fetchedAt) {
            memory.set(key, { data: entry.data, fetchedAt: entry.fetchedAt });
            emit(key);
        }
    } catch (e) {
        logger.error("Could not read cache", e);
    }
}

// ---------------------------------------------------------------- Loading

/** Load data if needed. force = ignore TTL (refresh button) */
export function load(provider: Provider, target: Target, force = false): Promise<void> {
    const key = cacheKey(provider, target);
    const running = inflight.get(key);
    if (running) return running;

    const promise = (async () => {
        await loadFromDisk(key);
        if (!force && isFresh(provider, memory.get(key))) return;

        const prev = memory.get(key);
        try {
            const data = await provider.fetch(target);
            const entry: CacheEntry = { data, fetchedAt: Date.now() };
            memory.set(key, entry);
            DataStore.set(key, entry, getStore()).catch(() => { });
        } catch (e) {
            const now = Date.now();
            const next: CacheEntry = { data: prev?.data, fetchedAt: prev?.fetchedAt, errorAt: now };
            if (e instanceof BackoffError) {
                next.backoffUntil = e.until;
                next.error = `Rate limited – next attempt ${new Date(e.until).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
            } else if (e instanceof HttpError) {
                next.error = e.message;
                next.notFound = e.status === 404;
            } else {
                next.error = "Failed to load";
                logger.error(`Error for ${key}`, e);
            }
            memory.set(key, next);
        }
    })().finally(() => {
        inflight.delete(key);
        emit(key);
    });

    inflight.set(key, promise);
    emit(key);
    return promise;
}

// ---------------------------------------------------------------- Cleanup

export async function clearCache() {
    memory.clear();
    loadedFromDisk.clear();
    try {
        await DataStore.clear(getStore());
    } catch (e) {
        logger.error("Could not clear cache", e);
    }
    for (const key of [...listeners.keys()]) emit(key);
}

export async function pruneCache() {
    try {
        const now = Date.now();
        const old: IDBValidKey[] = [];
        for (const [key, entry] of await DataStore.entries<IDBValidKey, CacheEntry>(getStore())) {
            if (!entry?.fetchedAt || now - entry.fetchedAt > MAX_AGE) old.push(key);
        }
        if (old.length) await DataStore.delMany(old, getStore());
    } catch (e) {
        logger.error("Could not clean up cache", e);
    }
}

export function resetMemory() {
    memory.clear();
    loadedFromDisk.clear();
    listeners.clear();
}
