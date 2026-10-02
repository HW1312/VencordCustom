/*
 * SplitView – Vencord Userplugin
 * Keep up to two more channels or DMs open as their own panels next to the main window.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { getCurrentChannel } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, Menu, showToast, Toasts } from "@webpack/common";

import { emitChannelEvent } from "./messages";
import { activate, mountFallbackRoot, renderTitleBarButton, setDragInfo, SettingsPanel, SPLIT_PATH, unmountAll } from "./ui";

export const logger = new Logger("SplitView");

export const MAX_PANELS = 2;
export const MIN_WIDTH = 300;
export const DEFAULT_WIDTH = 420;

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    /** Open panels as JSON: [{ channelId, guildId }] */
    panels: {
        type: OptionType.STRING,
        description: "internal",
        default: "[]",
        hidden: true
    },
    /** Widths of the panel slots (left → right) as JSON */
    widths: {
        type: OptionType.STRING,
        description: "internal",
        default: `[${DEFAULT_WIDTH},${DEFAULT_WIDTH}]`,
        hidden: true
    },
    visible: {
        type: OptionType.BOOLEAN,
        description: "Show SplitView",
        default: true,
        hidden: true
    },
    showTitleBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show icon in the title bar",
        default: true,
        hidden: true
    },
    shortcut: {
        type: OptionType.BOOLEAN,
        description: "Ctrl + Shift + S opens the current channel in SplitView",
        default: true,
        hidden: true
    },
    dragDrop: {
        type: OptionType.BOOLEAN,
        description: "Open channels via drag & drop",
        default: true,
        hidden: true
    },
    showTyping: {
        type: OptionType.BOOLEAN,
        description: "Show who is currently typing",
        default: true,
        hidden: true
    }
});

// ---------------------------------------------------------------- Panels

export interface PanelEntry {
    channelId: string;
    guildId: string | null;
}

export function parsePanels(raw: string | undefined): PanelEntry[] {
    try {
        const list = JSON.parse(raw || "[]");
        if (!Array.isArray(list)) return [];
        return list
            .filter(p => p && typeof p.channelId === "string")
            .map(p => ({ channelId: p.channelId, guildId: typeof p.guildId === "string" ? p.guildId : null }))
            .slice(0, MAX_PANELS);
    } catch {
        return [];
    }
}

export function parseWidths(raw: string | undefined): number[] {
    let list: unknown;
    try {
        list = JSON.parse(raw || "[]");
    } catch { /* defaults */ }
    const arr = Array.isArray(list) ? list : [];
    return Array.from({ length: MAX_PANELS }, (_, i) => {
        const n = Number(arr[i]);
        return Number.isFinite(n) && n >= MIN_WIDTH ? Math.round(n) : DEFAULT_WIDTH;
    });
}

export const getPanels = () => parsePanels(settings.store.panels);

function savePanels(list: PanelEntry[]) {
    settings.store.panels = JSON.stringify(list.slice(0, MAX_PANELS));
}

export function setPanelWidth(index: number, width: number) {
    const widths = parseWidths(settings.store.widths);
    widths[index] = Math.max(MIN_WIDTH, Math.round(width));
    settings.store.widths = JSON.stringify(widths);
}

export function openPanel(channelId: string | null | undefined, guildId?: string | null) {
    if (!channelId) return;
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) {
        showToast("SplitView: Channel not found", Toasts.Type.FAILURE);
        return;
    }
    if (!isTextCapable(channel)) {
        showToast("SplitView: This channel has no text chat", Toasts.Type.FAILURE);
        return;
    }

    const list = getPanels();
    settings.store.visible = true;
    if (list.some(p => p.channelId === channelId)) {
        showToast("SplitView: Channel is already open", Toasts.Type.MESSAGE);
        return;
    }
    if (list.length >= MAX_PANELS) {
        showToast(`SplitView: Maximum of ${MAX_PANELS} panels – close one first`, Toasts.Type.FAILURE);
        return;
    }
    list.push({ channelId, guildId: guildId ?? channel.guild_id ?? null });
    savePanels(list);
}

export function closePanel(channelId: string) {
    savePanels(getPanels().filter(p => p.channelId !== channelId));
}

export function movePanel(channelId: string, dir: -1 | 1) {
    const list = getPanels();
    const i = list.findIndex(p => p.channelId === channelId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    savePanels(list);
}

export function toggleVisible() {
    settings.store.visible = !settings.store.visible;
}

/** Categories, forums & media channels have no chat of their own */
export function isTextCapable(channel: any) {
    return channel != null && ![4, 14, 15, 16].includes(channel.type);
}

// ---------------------------------------------------------------- Context menus

function menuItem(channelId: string | undefined, guildId?: string | null) {
    const open = getPanels().some(p => p.channelId === channelId);
    return (
        <Menu.MenuItem
            id="vc-splitview-open"
            key="vc-splitview-open"
            label={open ? "Close in SplitView" : "Open in SplitView"}
            icon={() => (
                <svg viewBox="0 0 24 24" width={18} height={18}>
                    <path fill="currentColor" d={SPLIT_PATH} />
                </svg>
            )}
            action={() => open ? closePanel(channelId!) : openPanel(channelId, guildId)}
        />
    );
}

function pushItem(children: any[], item: React.ReactElement) {
    const group = findGroupChildrenByChildId(["mark-channel-read", "mute-channel", "unmute-channel", "close-dm"], children);
    (group ?? children).push(item);
}

const channelContextPatch: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel || !isTextCapable(channel)) return;
    pushItem(children, menuItem(channel.id, channel.guild_id));
};

const userContextPatch: NavContextMenuPatchCallback = (children, { user, channel }) => {
    // In the DM list Discord provides the DM channel; otherwise only offer existing DMs
    const channelId = channel?.isPrivate?.() ? channel.id : user?.id ? ChannelStore.getDMFromUserId(user.id) : undefined;
    if (!channelId) return;
    pushItem(children, menuItem(channelId, null));
};

// ---------------------------------------------------------------- Keyboard shortcut & drag & drop

function onKeyDown(e: KeyboardEvent) {
    if (!settings.store.shortcut) return;
    if (e.code !== "KeyS" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const channel = getCurrentChannel();
    if (!channel) {
        showToast("SplitView: No channel selected", Toasts.Type.FAILURE);
        return;
    }
    openPanel(channel.id, channel.guild_id);
}

const CHANNEL_HREF = /^\/channels\/(@me|\d+)\/(\d+)/;

export function parseChannelHref(href: string | null | undefined) {
    if (!href) return null;
    try {
        const path = href.startsWith("/") ? href : new URL(href).pathname;
        const m = CHANNEL_HREF.exec(path);
        if (!m) return null;
        return { guildId: m[1] === "@me" ? null : m[1], channelId: m[2] };
    } catch {
        return null;
    }
}

function onDragStart(e: DragEvent) {
    if (!settings.store.dragDrop) return;
    const anchor = (e.target as Element | null)?.closest?.('a[href^="/channels/"]') as HTMLAnchorElement | null;
    // Ignore links inside our own panels (e.g. channel mentions)
    if (!anchor || anchor.closest(".vc-splitview-root")) return;
    const info = parseChannelHref(anchor.getAttribute("href"));
    if (info) setDragInfo(info);
}

function onDragEnd() {
    // The drop handler runs before dragend – delay briefly so it still sees the info
    setTimeout(() => setDragInfo(null), 0);
}

// ---------------------------------------------------------------- Plugin

let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

const plugin = definePlugin({
    name: "SplitView",
    description: "Keep up to two more channels/DMs open as their own panels to the right of the main window (context menu, drag & drop, Ctrl+Shift+S)",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Chat", "Utility"],
    settings,

    patches: [
        {
            // Left side of the title bar (next to back/forward & inbox): append the button at the end.
            // Order of plugin icons = load order of the plugins (alphabetical by folder).
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,2500}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        }
    ],

    renderTitleBarButton,

    contextMenus: {
        "channel-context": channelContextPatch,
        "thread-context": channelContextPatch,
        "gdm-context": channelContextPatch,
        "user-context": userContextPatch
    },

    // Only pass messages on – this does not mark anything as read in Discord
    flux: {
        MESSAGE_CREATE(e: any) {
            if (e.isPushNotification || !e.message) return;
            emitChannelEvent(e.channelId ?? e.message.channel_id, { type: "create", message: e.message, optimistic: !!e.optimistic });
        },
        MESSAGE_UPDATE(e: any) {
            if (e.message?.channel_id) emitChannelEvent(e.message.channel_id, { type: "update", message: e.message });
        },
        MESSAGE_DELETE(e: any) {
            emitChannelEvent(e.channelId, { type: "delete", ids: [e.id] });
        },
        MESSAGE_DELETE_BULK(e: any) {
            emitChannelEvent(e.channelId, { type: "delete", ids: e.ids ?? [] });
        },
        MESSAGE_SEND_FAILED(e: any) {
            emitChannelEvent(e.channelId, { type: "failed", id: e.messageId });
        },
        MESSAGE_REACTION_ADD(e: any) {
            emitChannelEvent(e.channelId, { type: "reaction", messageId: e.messageId, userId: e.userId, emoji: e.emoji, delta: 1 });
        },
        MESSAGE_REACTION_REMOVE(e: any) {
            emitChannelEvent(e.channelId, { type: "reaction", messageId: e.messageId, userId: e.userId, emoji: e.emoji, delta: -1 });
        },
        MESSAGE_REACTION_REMOVE_ALL(e: any) {
            emitChannelEvent(e.channelId, { type: "reactionClear", messageId: e.messageId });
        },
        MESSAGE_REACTION_REMOVE_EMOJI(e: any) {
            emitChannelEvent(e.channelId, { type: "reactionClear", messageId: e.messageId, emoji: e.emoji });
        }
    },

    toolboxActions: {
        "Show/hide SplitView": () => toggleVisible(),
        "Open current channel in SplitView": () => {
            const channel = getCurrentChannel();
            if (channel) openPanel(channel.id, channel.guild_id);
        }
    },

    start() {
        activate();
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("dragstart", onDragStart, true);
        document.addEventListener("dragend", onDragEnd, true);
        // Normally the title bar button renders the panels (portal in the Discord tree).
        // If it does not show up (patch broken), use our own React root.
        fallbackTimer = setTimeout(() => {
            try {
                mountFallbackRoot();
            } catch (e) {
                logger.error("Fallback root could not be created", e);
            }
        }, 4000);
    },

    stop() {
        clearTimeout(fallbackTimer);
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("dragstart", onDragStart, true);
        document.removeEventListener("dragend", onDragEnd, true);
        setDragInfo(null);
        unmountAll();
    }
});

export default plugin;
