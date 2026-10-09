/*
 * Radar – data model & storage (DataStore)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { useForceUpdater } from "@utils/react";
import { useEffect } from "@webpack/common";

export const logger = new Logger("Radar");

// ---------------------------------------------------------------- Types

export type TriggerType = "keyword" | "mention" | "voiceJoin" | "voiceLeave" | "gameStart" | "gameStop" | "time";
export type ActionType = "notify" | "sound" | "status" | "flash" | "highlight" | "inbox";
export type ScopeMode = "all" | "guilds" | "channels" | "dms";
export type StatusValue = "online" | "idle" | "dnd" | "invisible";

/** Trigger config: `type` + freely defined fields per trigger type (see engine.ts) */
export interface TriggerConfig {
    type: TriggerType;
    [key: string]: any;
}

export interface ActionConfig {
    type: ActionType;
    [key: string]: any;
}

export interface Conditions {
    /** Only fire when Discord is not in the foreground */
    onlyUnfocused: boolean;
    /** Don't fire while my status is "Do Not Disturb" */
    skipWhenDnd: boolean;
    /** Only active within a time window */
    hoursEnabled: boolean;
    hoursFrom: string;
    hoursTo: string;
}

export interface Rule {
    id: string;
    name: string;
    enabled: boolean;
    trigger: TriggerConfig;
    conditions: Conditions;
    actions: ActionConfig[];
    createdAt: number;
}

export interface InboxItem {
    id: string;
    at: number;
    read: boolean;
    kind: TriggerType | "reminder";
    ruleId?: string;
    ruleName: string;
    title: string;
    body: string;
    guildId?: string | null;
    channelId?: string;
    messageId?: string;
    icon?: string;
}

/** Snapshot of a message - stays viewable even if it is no longer in the cache */
export interface MessageSnapshot {
    guildId: string | null;
    channelId: string;
    messageId: string;
    authorId: string;
    authorName: string;
    /** Unique Discord username (@name), authorName is the display name */
    authorUsername?: string;
    authorAvatar?: string;
    content: string;
    timestamp: number;
    attachments: number;
    guildName?: string;
    channelName?: string;
}

export interface Reminder {
    id: string;
    createdAt: number;
    dueAt: number;
    note: string;
    message?: MessageSnapshot;
    done: boolean;
    firedAt?: number;
    missed?: boolean;
}

/** Image, video or file of a bookmarked message */
export interface SavedMedia {
    /** Attachment id, or "embed-<n>" for pictures/videos from links */
    key: string;
    kind: "image" | "video" | "file";
    name: string;
    /** Discord CDN address - expires after a while and is gone once the message is deleted */
    url: string;
    width?: number;
    height?: number;
    size?: number;
    /** File name in the bookmark's folder on this PC, once saved */
    local?: string;
}

export interface Bookmark {
    id: string;
    createdAt: number;
    tags: string[];
    note: string;
    message: MessageSnapshot;
    media?: SavedMedia[];
    /** Keep images, videos and the avatar on this PC */
    offline?: boolean;
    /** Avatar file in the bookmark's folder */
    avatarLocal?: string;
    /** "saving" while downloading, "failed" if some files could not be saved */
    saveState?: "saving" | "failed";
}

export const DEFAULT_CONDITIONS: Conditions = {
    onlyUnfocused: false,
    skipWhenDnd: false,
    hoursEnabled: false,
    hoursFrom: "08:00",
    hoursTo: "22:00"
};

// ---------------------------------------------------------------- Storage

type Listener = () => void;

/** A value kept in the DataStore that re-renders components when it changes */
export class Persisted<T> {
    value: T;
    loaded = false;
    private listeners = new Set<Listener>();
    private saveTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private key: string, private fallback: () => T) {
        this.value = fallback();
    }

    async load() {
        try {
            const stored = await DataStore.get<T>(this.key);
            this.value = stored ?? this.fallback();
        } catch (e) {
            logger.error(`"${this.key}" could not be loaded`, e);
            this.value = this.fallback();
        }
        this.loaded = true;
        this.emit();
    }

    set(value: T) {
        this.value = value;
        this.emit();
        // Save in batches (e.g. many history entries in quick succession)
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.flush(), 300);
    }

    update(fn: (v: T) => T) {
        this.set(fn(this.value));
    }

    flush() {
        clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
        if (!this.loaded) return;
        DataStore.set(this.key, this.value).catch(e => logger.error(`"${this.key}" could not be saved`, e));
    }

    subscribe(fn: Listener) {
        this.listeners.add(fn);
        return () => void this.listeners.delete(fn);
    }

    private emit() {
        for (const fn of this.listeners) {
            try {
                fn();
            } catch (e) {
                logger.error("Listener error", e);
            }
        }
    }
}

export const rulesStore = new Persisted<Rule[]>("Radar_rules", () => []);
export const inboxStore = new Persisted<InboxItem[]>("Radar_inbox", () => []);
export const remindersStore = new Persisted<Reminder[]>("Radar_reminders", () => []);
export const bookmarksStore = new Persisted<Bookmark[]>("Radar_bookmarks", () => []);

export const ALL_STORES = [rulesStore, inboxStore, remindersStore, bookmarksStore];

export function useStore<T>(store: Persisted<T>): T {
    const forceUpdate = useForceUpdater();
    useEffect(() => store.subscribe(forceUpdate), [store]);
    return store.value;
}

/** Simple event for unsaved state (e.g. highlights) */
export class Signal {
    private listeners = new Set<Listener>();
    version = 0;
    subscribe(fn: Listener) {
        this.listeners.add(fn);
        return () => void this.listeners.delete(fn);
    }
    emit() {
        this.version++;
        this.listeners.forEach(fn => fn());
    }
}

export function useSignal(signal: Signal) {
    const forceUpdate = useForceUpdater();
    useEffect(() => signal.subscribe(forceUpdate), [signal]);
    return signal.version;
}

// ---------------------------------------------------------------- Helpers

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const INBOX_LIMIT = 300;

export function addInboxItem(item: Omit<InboxItem, "id" | "at" | "read">) {
    inboxStore.update(list => [{ ...item, id: uid(), at: Date.now(), read: false }, ...list].slice(0, INBOX_LIMIT));
}

export function markAllRead() {
    if (!inboxStore.value.some(i => !i.read)) return;
    inboxStore.update(list => list.map(i => i.read ? i : { ...i, read: true }));
}

export function upsertRule(rule: Rule) {
    rulesStore.update(list => list.some(r => r.id === rule.id) ? list.map(r => r.id === rule.id ? rule : r) : [...list, rule]);
}

export function deleteRule(id: string) {
    rulesStore.update(list => list.filter(r => r.id !== id));
}

export function toggleRule(id: string, enabled: boolean) {
    rulesStore.update(list => list.map(r => r.id === id ? { ...r, enabled } : r));
}
