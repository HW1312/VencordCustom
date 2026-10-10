/*
 * DoomScroll – Vencord Userplugin
 * Scroll TikTok, YouTube Shorts or Instagram Reels right where the chat normally is - pick a feed from the title
 * bar, close it again with one click. The feed is a real browser view with its own login, layered over Discord.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";

import { titleBarSlot } from "../_ui";
import { closeFeed, openFeed, reset } from "./controller";
import { mountRoot, renderTitleBarButton, SettingsPanel, unmountRoot } from "./ui";

export const Native = (VencordNative as any)?.pluginHelpers?.DoomScroll as PluginNative<typeof import("./native")> | undefined;

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    /** replace = covers header, chat & member list, chat = only the chat, side = docked on the right next to the chat */
    layout: {
        type: OptionType.STRING,
        description: "Layout",
        default: "replace",
        hidden: true
    },
    sideWidth: {
        type: OptionType.NUMBER,
        description: "Width of the side panel (px)",
        default: 420,
        hidden: true
    },
    /** Page zoom of the feed in percent */
    zoom: {
        type: OptionType.NUMBER,
        description: "Feed zoom (%)",
        default: 100,
        hidden: true
    },
    muted: {
        type: OptionType.BOOLEAN,
        description: "Mute the feed",
        default: false,
        hidden: true
    },
    /** Feed volume in percent, applied to every video/audio element of the page */
    volume: {
        type: OptionType.NUMBER,
        description: "Feed volume (%)",
        default: 100,
        hidden: true
    },
    pauseWhenHidden: {
        type: OptionType.BOOLEAN,
        description: "Pause the video while the feed is hidden",
        default: true,
        hidden: true
    },
    keepLoaded: {
        type: OptionType.BOOLEAN,
        description: "Keep your place in the feed after closing it",
        default: true,
        hidden: true
    },
    showTitleBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show the button in the title bar",
        default: true,
        hidden: true
    },
    lastPlatform: {
        type: OptionType.STRING,
        description: "Last opened feed",
        default: "tiktok",
        hidden: true
    }
});

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "DoomScroll",
    description: "Scroll TikTok, YouTube Shorts or Instagram Reels right where the chat is - open it from the title bar",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Fun", "Media"],
    settings,

    patches: [
        {
            // Left side of the title bar (next to Back/Forward & Inbox): append the button at the end.
            // Other plugins patch the same spot - each appends its own button, order = plugin load order.
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,2500}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        }
    ],

    renderTitleBarButton: titleBarSlot("DoomScroll", renderTitleBarButton),

    toolboxActions: {
        "Open TikTok": () => openFeed("tiktok"),
        "Open YouTube Shorts": () => openFeed("shorts"),
        "Open Instagram Reels": () => openFeed("reels"),
        "Close feed": () => closeFeed()
    },

    start() {
        // A view left over from before a Discord reload (Ctrl+R) still sits in the main process
        reset();
        mountRoot();
    },

    stop() {
        reset();
        unmountRoot();
    }
});
