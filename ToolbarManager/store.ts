/*
 * ToolbarManager – data model, storage (DataStore) & profiles
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButtonMap } from "@api/ChatButtons";
import * as DataStore from "@api/DataStore";
import { Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { useForceUpdater } from "@utils/react";
import { useEffect } from "@webpack/common";

export const logger = new Logger("ToolbarManager");

// ---------------------------------------------------------------- Types

export type Bar = "chat" | "title";
export type ButtonState = "visible" | "menu" | "hidden";
export type ButtonKind = "vencord" | "native" | "plugin";

/** A button that has been detected once - stays stored even when it is not currently shown */
export interface SeenButton {
    key: string;
    name: string;
    kind: ButtonKind;
    /** Sanitized SVG markup as a preview (optional) */
    icon?: string;
    lastSeen: number;
}

export interface BarData {
    seen: Record<string, SeenButton>;
    order: string[];
    states: Record<string, ButtonState>;
}

export interface CustomProfile {
    id: string;
    name: string;
    chat: { order: string[]; states: Record<string, ButtonState>; };
    title: { order: string[]; states: Record<string, ButtonState>; };
    /** Vencord chat buttons hidden via Vencord's own setting */
    vencordHidden: string[];
}

export interface Data {
    chat: BarData;
    title: BarData;
    profiles: CustomProfile[];
}

export const BARS: Bar[] = ["chat", "title"];
export const BAR_LABEL: Record<Bar, string> = { chat: "Chat bar", title: "Title bar" };

/** Our own ⋯ buttons - always visible (as soon as something is in the menu), can never be hidden */
export const PLUGIN_ID = "ToolbarManager";
export const DOCK_KEY: Record<Bar, string> = { chat: `vc:${PLUGIN_ID}`, title: "t:vc-toolbarmanager" };

const emptyBar = (): BarData => ({ seen: {}, order: [], states: {} });
const fallback = (): Data => ({ chat: emptyBar(), title: emptyBar(), profiles: [] });

// ---------------------------------------------------------------- Storage

const STORE_KEY = "ToolbarManager_data";

type Listener = () => void;
const listeners = new Set<Listener>();

export let data: Data = fallback();
/** Is the plugin currently running? (title bar patch stays active until restart) */
export const runtime = { running: false };
export let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Which buttons are currently in the DOM (not persisted) */
export const present: Record<Bar, Set<string>> = { chat: new Set(), title: new Set() };

export function subscribe(l: Listener) {
    listeners.add(l);
    return () => void listeners.delete(l);
}

export function emit() {
    for (const l of listeners) {
        try { l(); } catch (e) { logger.error("Listener error", e); }
    }
}

export async function loadData() {
    try {
        const stored = await DataStore.get<Data>(STORE_KEY);
        data = stored ? { ...fallback(), ...stored } : fallback();
        for (const b of BARS) data[b] = { ...emptyBar(), ...data[b] };
    } catch (e) {
        logger.error("Failed to load data", e);
        data = fallback();
    }
    loaded = true;
    emit();
}

/** Modify data (immutably) - re-renders and saves in batches */
export function update(fn: (d: Data) => Data | void) {
    const copy: Data = structuredClone(data);
    data = fn(copy) ?? copy;
    emit();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
}

export function flush() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!loaded) return;
    DataStore.set(STORE_KEY, data).catch(e => logger.error("Failed to save data", e));
}

/** Re-render when data or detected buttons change */
export function useToolbarData() {
    const force = useForceUpdater();
    useEffect(() => subscribe(force), []);
    return data;
}

// ---------------------------------------------------------------- Vencord chat buttons

export const isVencordKey = (key: string) => key.startsWith("vc:");
export const vencordId = (key: string) => key.slice(3);

function vencordButtonSettings() {
    return Settings.uiElements.chatBarButtons;
}

export function isVencordHidden(key: string) {
    return vencordButtonSettings()[vencordId(key)]?.enabled === false;
}

function setVencordHidden(key: string, hidden: boolean) {
    const s = vencordButtonSettings();
    const id = vencordId(key);
    if ((s[id]?.enabled === false) === hidden) return;
    s[id] ??= {} as any;
    s[id].enabled = !hidden;
}

// ---------------------------------------------------------------- States

export function getState(bar: Bar, key: string): ButtonState {
    if (key === DOCK_KEY[bar]) return "visible";
    // Hidden Vencord buttons: Vencord's own setting is the source of truth (they are then not rendered at all)
    if (bar === "chat" && isVencordKey(key) && isVencordHidden(key)) return "hidden";
    return data[bar].states[key] ?? "visible";
}

export function setState(bar: Bar, key: string, state: ButtonState) {
    if (key === DOCK_KEY[bar]) return;
    if (bar === "chat" && isVencordKey(key)) {
        setVencordHidden(key, state === "hidden");
        state = state === "hidden" ? (data.chat.states[key] ?? "visible") : state;
    }
    update(d => { d[bar].states[key] = state; });
}

/** All known keys of a bar in display order */
export function listKeys(bar: Bar): string[] {
    const d = data[bar];
    const keys = [...d.order];
    const known = new Set(keys);
    const add = (k: string) => { if (!known.has(k)) { known.add(k); keys.push(k); } };
    for (const k of Object.keys(d.seen)) add(k);
    if (bar === "chat") for (const id of ChatBarButtonMap.keys()) add(`vc:${id}`);
    return keys;
}

export function moveKey(bar: Bar, key: string, toIndex: number) {
    const keys = listKeys(bar);
    const from = keys.indexOf(key);
    if (from === -1) return;
    keys.splice(from, 1);
    keys.splice(Math.max(0, Math.min(toIndex, keys.length)), 0, key);
    update(d => { d[bar].order = keys; });
}

export function forget(bar: Bar, key: string) {
    update(d => {
        delete d[bar].seen[key];
        delete d[bar].states[key];
        d[bar].order = d[bar].order.filter(k => k !== key);
    });
}

/** Remember newly detected buttons; `domKeys` in DOM order */
export function registerSeen(bar: Bar, found: SeenButton[], domKeys: string[]) {
    const d = data[bar];
    const newOnes = found.filter(f => !d.seen[f.key]);
    const orderMissing = domKeys.filter(k => !d.order.includes(k));
    const iconMissing = found.filter(f => d.seen[f.key] && !d.seen[f.key].icon && f.icon);
    if (!newOnes.length && !orderMissing.length && !iconMissing.length) return;

    update(dd => {
        const b = dd[bar];
        for (const f of newOnes) b.seen[f.key] = f;
        for (const f of iconMissing) b.seen[f.key].icon = f.icon;

        if (orderMissing.length) {
            const dock = DOCK_KEY[bar];
            const dockWasLast = b.order.length > 0 && b.order[b.order.length - 1] === dock;
            const order = b.order.filter(k => k !== dock || !dockWasLast);
            // Insert new keys after their DOM predecessor so the natural order is preserved
            for (const k of orderMissing) {
                if (k === dock) continue;
                const domIdx = domKeys.indexOf(k);
                let insertAt = order.length;
                for (let i = domIdx - 1; i >= 0; i--) {
                    const prev = order.indexOf(domKeys[i]);
                    if (prev !== -1 && domKeys[i] !== dock) { insertAt = prev + 1; break; }
                }
                order.splice(insertAt, 0, k);
            }
            // Own ⋯ button: at the very end by default
            if (!order.includes(dock)) order.push(dock);
            b.order = order;
        }
    });
}

// ---------------------------------------------------------------- Profiles

type NativeType = "emoji" | "gif" | "sticker" | "gift" | "apps" | "other";

/** Classify Discord's own buttons by their (localized) aria-label */
export function nativeType(key: string): NativeType {
    const label = key.slice(2);
    if (/emoji/i.test(label)) return "emoji";
    if (/\bgif/i.test(label)) return "gif";
    if (/sticker/i.test(label)) return "sticker";
    if (/geschenk|gift|nitro/i.test(label)) return "gift";
    if (/\bapps?\b|aktivit|activit|anwendung/i.test(label)) return "apps";
    return "other";
}

export type BuiltinProfile = "minimal" | "standard" | "all";

export const BUILTIN_PROFILES: { id: BuiltinProfile; label: string; hint: string; }[] = [
    { id: "minimal", label: "Minimal", hint: "Only emoji + ⋯ visible, everything else in the ⋯ menu. Title bar: plugin icons go into the ⋯ menu." },
    { id: "standard", label: "Standard", hint: "Gift, stickers & apps go into the ⋯ menu, the rest stays visible. Title bar stays fully visible." },
    { id: "all", label: "All", hint: "All buttons and icons visible." }
];

function builtinState(profile: BuiltinProfile, bar: Bar, key: string): ButtonState {
    if (profile === "all") return "visible";
    if (bar === "title") {
        // Discord's navigation (Back/Forward) always stays visible
        if (!key.startsWith("t:vc-")) return "visible";
        return profile === "minimal" ? "menu" : "visible";
    }
    const type = key.startsWith("n:") ? nativeType(key) : "other";
    if (profile === "minimal") return type === "emoji" ? "visible" : "menu";
    if (key.startsWith("n:") && (type === "gift" || type === "sticker" || type === "apps")) return "menu";
    return "visible";
}

export function applyBuiltinProfile(profile: BuiltinProfile) {
    for (const bar of BARS) {
        for (const key of listKeys(bar)) {
            if (key === DOCK_KEY[bar]) continue;
            setState(bar, key, builtinState(profile, bar, key));
        }
    }
}

export function snapshotProfile(name: string): CustomProfile {
    return {
        id: Math.random().toString(36).slice(2, 10),
        name,
        chat: { order: listKeys("chat"), states: { ...data.chat.states } },
        title: { order: listKeys("title"), states: { ...data.title.states } },
        vencordHidden: listKeys("chat").filter(k => isVencordKey(k) && isVencordHidden(k))
    };
}

export function applyCustomProfile(p: CustomProfile) {
    for (const key of listKeys("chat")) {
        if (isVencordKey(key) && key !== DOCK_KEY.chat) setVencordHidden(key, p.vencordHidden.includes(key));
    }
    update(d => {
        for (const bar of BARS) {
            d[bar].order = [...p[bar].order];
            d[bar].states = { ...p[bar].states };
        }
    });
}

/** Reset: everything visible, natural order - detected buttons stay stored */
export function resetAll() {
    for (const key of listKeys("chat")) {
        if (isVencordKey(key) && key !== DOCK_KEY.chat) setVencordHidden(key, false);
    }
    update(d => {
        for (const bar of BARS) {
            d[bar].states = {};
            d[bar].order = [];
        }
    });
}
