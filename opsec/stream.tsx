/*
 * OpSec – Streaming protection (ScreenshareGuard)
 * While you are streaming / sharing your screen:
 *  - blur the DM list (and DM bubbles in the server bar)
 *  - hide selected servers & channels
 *  - mute desktop notifications & sounds (via Discord's own Streamer Mode) and
 *    hide Vencord popups
 *  - optionally turn on Discord's Streamer Mode
 *
 * Detection like the stock plugin "StreamerModeOnStream" (STREAM_CREATE/STREAM_DELETE) plus STREAM_START,
 * so the protection kicks in before the first frame is transmitted.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { ApplicationStreamingStore, FluxDispatcher, showToast, SortedGuildStore, StreamerModeStore, Toasts } from "@webpack/common";

const logger = new Logger("OpSec");

export interface GuardOptions {
    enabled: boolean;
    notifications: boolean;
    blurDms: boolean;
    revealOnHover: boolean;
    streamerMode: boolean;
    hiddenGuilds: string[];
    hiddenChannels: string[];
}

let getOptions: () => GuardOptions = () => ({
    enabled: false, notifications: true, blurDms: true, revealOnHover: false, streamerMode: false,
    hiddenGuilds: [], hiddenChannels: []
});

export function configureGuard(provider: () => GuardOptions) {
    getOptions = provider;
}

// ---------------------------------------------------------------- State

let streaming = false;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let startCheckTimer: ReturnType<typeof setTimeout> | undefined;
let style: HTMLStyleElement | null = null;
const listeners = new Set<() => void>();

export const isGuardActive = () => streaming;
export const isGuardPreview = () => previewTimer !== undefined;

export function onGuardChange(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

const emit = () => listeners.forEach(l => l());

// ---------------------------------------------------------------- CSS

const DM_LINK = 'a[href^="/channels/@me/"]';
const snowflake = (id: string) => /^\d{15,21}$/.test(id);
const TIP_CLASS = "vc-opsec-hide-tips";

interface FolderInfo { id: string; guildIds: string[]; }

function getFolders(): FolderInfo[] {
    try {
        return (SortedGuildStore.getGuildFolders?.() ?? [])
            .filter((f: any) => f.folderId != null && f.guildIds?.length)
            .map((f: any) => ({ id: String(f.folderId), guildIds: f.guildIds as string[] }));
    } catch {
        return [];
    }
}

/** Folders that contain at least one hidden server (their tooltip lists all server names) */
let sensitiveFolders = new Set<string>();

export function buildGuardCss(o: GuardOptions, folders: FolderInfo[] = []) {
    const rules: string[] = [];

    if (o.blurDms) {
        // DM list in the sidebar + unread DMs (avatars) at the top of the server bar
        const targets = [
            `nav ${DM_LINK}`,
            `[class*="privateChannels"] ${DM_LINK}`,
            'ul[data-list-id="guildsnav"] [data-list-item-id^="guildsnav___"]:has(img[src*="/avatars/"], img[src*="/channel-icons/"])'
        ];
        rules.push(`${targets.join(",\n")} {
    filter: blur(7px) saturate(0.6) !important;
    transition: filter 0.2s;
}`);
        if (o.revealOnHover) rules.push(`${targets.map(t => t + ":hover").join(",\n")} {
    filter: none !important;
}`);
    }

    const guilds = o.hiddenGuilds.filter(snowflake);
    if (guilds.length) {
        // Only entries that contain exactly this one server (not the whole folder)
        rules.push(guilds.map(id =>
            `div[class*="listItem"]:has([data-list-item-id="guildsnav___${id}"]):not(:has([data-list-item-id^="guildsnav___"]:not([data-list-item-id="guildsnav___${id}"])))`
        ).join(",\n") + " {\n    display: none !important;\n}");

        // Folders: hide completely if every server in it is hidden, otherwise only the icons of the hidden servers
        const hiddenSet = new Set(guilds);
        const fullyHidden: string[] = [];
        const partial: string[] = [];
        for (const f of folders) {
            const hits = f.guildIds.filter(id => hiddenSet.has(id));
            if (!hits.length) continue;
            if (hits.length === f.guildIds.length) fullyHidden.push(f.id);
            else partial.push(...hits.map(id => `[data-list-item-id="guildsnav___${f.id}"] img[src*="/icons/${id}/"]`));
        }
        if (fullyHidden.length) rules.push(fullyHidden.map(id => {
            const item = `[data-list-item-id="guildsnav___${id}"]`;
            return `[class*="folderGroup"]:has(${item}),\n`
                + `div[class*="listItem"]:has(${item}):not(:has([data-list-item-id^="guildsnav___"]:not(${item})))`;
        }).join(",\n") + " {\n    display: none !important;\n}");
        if (partial.length) rules.push(partial.join(",\n") + " {\n    visibility: hidden !important;\n}");
        // Folder tooltips list the server names – suppressed while hovering such a folder (see trackFolderHover)
        rules.push(`html.${TIP_CLASS} [role="tooltip"],\nhtml.${TIP_CLASS} [class*="layerContainer"] [class*="tooltip"] {\n    display: none !important;\n}`);
    }

    const channels = o.hiddenChannels.filter(snowflake);
    if (channels.length) {
        rules.push(channels.map(id => `li:has([data-list-item-id="channels___${id}"])`).join(",\n")
            + " {\n    display: none !important;\n}");
    }

    // Don't show popups from other Vencord plugins (e.g. "X unfriended you") on stream
    if (o.notifications) rules.push(".vc-notification-root {\n    display: none !important;\n}");

    return rules.join("\n");
}

function onPointerOver(e: PointerEvent) {
    const item = (e.target as Element | null)?.closest?.('[data-list-item-id^="guildsnav___"]');
    const id = item?.getAttribute("data-list-item-id")?.slice("guildsnav___".length);
    document.documentElement.classList.toggle(TIP_CLASS, !!id && sensitiveFolders.has(id));
}

function trackFolderHover(on: boolean) {
    document.removeEventListener("pointerover", onPointerOver, true);
    document.documentElement.classList.remove(TIP_CLASS);
    if (on) document.addEventListener("pointerover", onPointerOver, true);
}

/** Folder layout can change mid-stream (server moved into a folder) → rebuild the rules */
const onFoldersChange = () => applyCss(streaming || isGuardPreview());
let watchingFolders = false;

function watchFolders(on: boolean) {
    if (on === watchingFolders) return;
    watchingFolders = on;
    try {
        if (on) SortedGuildStore.addChangeListener(onFoldersChange);
        else SortedGuildStore.removeChangeListener(onFoldersChange);
    } catch (e) {
        logger.error("Failed to watch server folders", e);
    }
}

function applyCss(on: boolean) {
    const o = getOptions();
    watchFolders(on && o.hiddenGuilds.length > 0);
    const folders = on ? getFolders() : [];
    const hidden = new Set(o.hiddenGuilds);
    sensitiveFolders = new Set(folders.filter(f => f.guildIds.some(id => hidden.has(id))).map(f => f.id));
    trackFolderHover(sensitiveFolders.size > 0);

    const css = on ? buildGuardCss(o, folders) : "";
    if (!css) {
        style?.remove();
        style = null;
        return;
    }
    if (!style) {
        style = document.createElement("style");
        style.id = "vc-opsec-stream-guard";
        document.head.appendChild(style);
    }
    style.textContent = css;
}

// ---------------------------------------------------------------- Discord's Streamer Mode

type StreamerKey = "enabled" | "disableNotifications" | "disableSounds";

/** Values OpSec changed for the stream (to restore them) */
const changedStreamerMode = new Map<StreamerKey, boolean>();

function setStreamerMode(key: StreamerKey, value: boolean) {
    FluxDispatcher.dispatch({ type: "STREAMER_MODE_UPDATE", key, value });
}

function applyStreamerMode(on: boolean) {
    const o = getOptions();
    // Discord only suppresses notifications while Streamer Mode is on
    const wanted: Partial<Record<StreamerKey, boolean>> = !on ? {} : {
        ...(o.streamerMode || o.notifications ? { enabled: true } : {}),
        ...(o.notifications ? { disableNotifications: true, disableSounds: true } : {})
    };

    try {
        // Revert changes that are no longer wanted
        for (const [key, original] of changedStreamerMode) {
            if (key in wanted) continue;
            if (StreamerModeStore[key] !== original) setStreamerMode(key, original);
            changedStreamerMode.delete(key);
        }
        for (const [key, value] of Object.entries(wanted) as [StreamerKey, boolean][]) {
            const current = StreamerModeStore[key];
            if (current === value) continue;
            if (!changedStreamerMode.has(key)) changedStreamerMode.set(key, current);
            setStreamerMode(key, value);
        }
    } catch (e) {
        logger.error("Failed to toggle Streamer Mode", e);
        showToast("OpSec: Failed to toggle Streamer Mode", Toasts.Type.FAILURE);
    }
}

// ---------------------------------------------------------------- Toggling

function ownStreamActive() {
    try {
        return !!ApplicationStreamingStore.getCurrentUserActiveStream?.();
    } catch {
        return false;
    }
}

function setStreaming(on: boolean) {
    if (on === streaming) return;
    streaming = on;
    applyCss(on || isGuardPreview());
    applyStreamerMode(on);
    emit();
}

/** After a stream event, check whether your own stream is currently running */
export function evaluateStream() {
    // The stores update within the same dispatch – check afterwards
    setTimeout(() => setStreaming(getOptions().enabled && ownStreamActive()), 0);
}

/** STREAM_START only fires for your own stream → protect immediately, before anything is transmitted */
export function onOwnStreamStart() {
    if (!getOptions().enabled) return;
    setStreaming(true);
    // If the start fails, no STREAM_DELETE arrives – re-check later
    clearTimeout(startCheckTimer);
    startCheckTimer = setTimeout(evaluateStream, 15_000);
}

/** Settings changed */
export function refreshGuard() {
    const { enabled } = getOptions();
    if (!enabled && streaming) return setStreaming(false);
    if (enabled && !streaming && ownStreamActive()) return setStreaming(true);
    applyCss(streaming || isGuardPreview());
    if (streaming) applyStreamerMode(true);
}

/** Shows the protection for a few seconds without streaming (view only, not Streamer Mode) */
export function previewGuard(seconds = 12) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(stopPreview, seconds * 1000);
    applyCss(true);
    emit();
}

export function stopPreview() {
    clearTimeout(previewTimer);
    previewTimer = undefined;
    applyCss(streaming);
    emit();
}

export function stopGuard() {
    clearTimeout(startCheckTimer);
    clearTimeout(previewTimer);
    previewTimer = undefined;
    streaming = false;
    applyCss(false);
    applyStreamerMode(false);
    emit();
}
