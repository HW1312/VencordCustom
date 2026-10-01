/*
 * OpSec – Streaming protection (ScreenshareGuard)
 * While you are streaming / sharing your screen:
 *  - blur the DM list (and DM bubbles in the server bar)
 *  - hide selected servers & channels
 *  - mute desktop notifications & sounds (via Discord's own Streamer Mode) and
 *    hide Vencord popups
 *  - optionally turn on Discord's Streamer Mode
 *  - checklist right after the stream starts with "End stream"
 *
 * Detection like the stock plugin "StreamerModeOnStream" (STREAM_CREATE/STREAM_DELETE) plus STREAM_START,
 * so the protection kicks in before the first frame is transmitted. Discord's stream start can't be intercepted
 * without an invented patch – that's why the checklist appears right after the start.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { Logger } from "@utils/Logger";
import { findByPropsLazy } from "@webpack";
import { ApplicationStreamingStore, FluxDispatcher, Modal, openModal, showToast, StreamerModeStore, Toasts } from "@webpack/common";

const cl = classNameFactory("vc-opsec-");
const logger = new Logger("OpSec");

/** Same lookup as in the stock plugin "UserVoiceShow" */
const VoiceActions = findByPropsLazy("selectVoiceChannel", "selectChannel");

export interface GuardOptions {
    enabled: boolean;
    notifications: boolean;
    blurDms: boolean;
    revealOnHover: boolean;
    streamerMode: boolean;
    checklist: boolean;
    hiddenGuilds: string[];
    hiddenChannels: string[];
}

let getOptions: () => GuardOptions = () => ({
    enabled: false, notifications: true, blurDms: true, revealOnHover: false, streamerMode: false,
    checklist: true, hiddenGuilds: [], hiddenChannels: []
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

export function buildGuardCss(o: GuardOptions) {
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

function applyCss(on: boolean) {
    const css = on ? buildGuardCss(getOptions()) : "";
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

// ---------------------------------------------------------------- Checklist

const CHECKLIST = [
    { title: "Password manager & accounts", hint: "Vault locked, no logged-in admin/banking pages open?" },
    { title: "Email & other chats", hint: "Inbox, WhatsApp, Telegram … closed or minimized?" },
    { title: "Tokens & keys", hint: "No .env files, API keys, Discord tokens or recovery codes visible?" },
    { title: "Personal info", hint: "Address, ID, invoices, bank statements, filenames with real names?" },
    { title: "Notifications from other apps", hint: "Windows shows popups from mail & co. on stream too – is \"Do not disturb\" on?" }
];

export function endStream() {
    try {
        VoiceActions.selectVoiceChannel(null);
    } catch (e) {
        logger.error("Failed to end stream", e);
        showToast("OpSec: Failed to end stream – please hang up manually", Toasts.Type.FAILURE);
    }
}

function showChecklist() {
    openModal(props => (
        <Modal
            {...props}
            size="sm"
            title="You are streaming now"
            subtitle="Quick check: is there anything on your screen that nobody should see?"
            actions={[
                { text: "End stream", variant: "critical-primary", onClick: () => { endStream(); props.onClose(); } },
                { text: "All clear", variant: "primary", onClick: props.onClose }
            ]}
        >
            <div className={`${cl("checklist")} vc-keep-motion`}>
                {CHECKLIST.map((c, i) => (
                    <div key={c.title} className={cl("checklist-item")} style={{ animationDelay: `${i * 40}ms` }}>
                        <span className={cl("checklist-num")}>{i + 1}</span>
                        <span className={cl("row-text")}>
                            <span className={cl("row-label")}>{c.title}</span>
                            <span className={cl("row-hint")}>{c.hint}</span>
                        </span>
                    </div>
                ))}
            </div>
        </Modal>
    ));
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
    if (on && getOptions().checklist) showChecklist();
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
