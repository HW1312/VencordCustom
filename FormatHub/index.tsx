/*
 * FormatHub – Vencord Userplugin
 * All Discord text formats in one place: real IDs, live preview, copy & insert, decoder and favorites.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { copyToClipboard } from "@utils/clipboard";
import { insertTextIntoChatInputBox } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { showToast } from "@webpack/common";

import { contextMenus } from "./menus";
import { FormatHubIcon, openFormatHub, SettingsPanel } from "./ui";

const logger = new Logger("FormatHub");

// ---------------------------------------------------------------- Settings

/** Saved format (favorite or recently used) */
export interface SavedFormat {
    label: string;
    syntax: string;
}

export const MAX_RECENT = 20;

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    closeOnInsert: {
        type: OptionType.BOOLEAN,
        description: "Close window after inserting",
        default: true,
        hidden: true
    },
    spaceAfterInsert: {
        type: OptionType.BOOLEAN,
        description: "Append a space after inserting",
        default: true,
        hidden: true
    },
    contextMenus: {
        type: OptionType.BOOLEAN,
        description: "“Copy as format” in right-click menus",
        default: true,
        hidden: true
    },
    trackRecent: {
        type: OptionType.BOOLEAN,
        description: "Remember recently used formats",
        default: true,
        hidden: true
    },
    lastTab: {
        type: OptionType.STRING,
        description: "Last opened tab",
        default: "mentions",
        hidden: true
    },
    favorites: {
        type: OptionType.CUSTOM,
        default: [] as SavedFormat[]
    },
    recent: {
        type: OptionType.CUSTOM,
        default: [] as SavedFormat[]
    }
});

// ---------------------------------------------------------------- Favorites & History

export function isFavorite(syntax: string) {
    return settings.store.favorites.some(f => f.syntax === syntax);
}

export function toggleFavorite(entry: SavedFormat) {
    const favs = settings.store.favorites;
    settings.store.favorites = isFavorite(entry.syntax)
        ? favs.filter(f => f.syntax !== entry.syntax)
        : [{ label: entry.label, syntax: entry.syntax }, ...favs];
}

export function pushRecent(entry: SavedFormat) {
    if (!settings.store.trackRecent) return;
    const rest = settings.store.recent.filter(r => r.syntax !== entry.syntax);
    settings.store.recent = [{ label: entry.label, syntax: entry.syntax }, ...rest].slice(0, MAX_RECENT);
}

// ---------------------------------------------------------------- Copy & Insert

export async function copyFormat(entry: SavedFormat) {
    try {
        await copyToClipboard(entry.syntax);
        pushRecent(entry);
        showToast(`Copied: ${entry.syntax.length > 60 ? entry.syntax.slice(0, 57) + "…" : entry.syntax}`, "success");
    } catch (e) {
        logger.error("Copy failed", e);
        showToast("Copy failed", "failure");
    }
}

/** Inserts the text into the last active chat input. Returns false if that was not possible. */
export function insertFormat(entry: SavedFormat) {
    try {
        insertTextIntoChatInputBox(settings.store.spaceAfterInsert ? entry.syntax + " " : entry.syntax);
        pushRecent(entry);
        return true;
    } catch (e) {
        logger.error("Insert failed", e);
        showToast("Insert failed – no chat input found", "failure");
        return false;
    }
}

// ---------------------------------------------------------------- Chat button

const FormatHubButton: ChatBarButtonFactory = ({ isAnyChat, channel }) => {
    if (!isAnyChat) return null;

    return (
        <ChatBarButton
            tooltip="FormatHub"
            onClick={() => openFormatHub(channel)}
            buttonProps={{ "aria-haspopup": "dialog" }}
        >
            <FormatHubIcon />
        </ChatBarButton>
    );
};

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "FormatHub",
    description: "All Discord text formats in one place: mentions, timestamps, emojis, markdown & links with real IDs, live preview, copy/insert, decoder and favorites",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Chat", "Utility"],
    settings,

    chatBarButton: {
        icon: FormatHubIcon,
        render: FormatHubButton
    },

    contextMenus,

    toolboxActions: {
        "Open FormatHub": () => openFormatHub()
    }
});
