/*
 * PeekAnything – Vencord Userplugin
 * Hold a key (Alt by default) to get a small floating preview of whatever the mouse is over: channels, DMs,
 * message links, streams and voice channels in the sidebar - or the stream of your current call when nothing
 * specific is hovered. Release to close, click into it to pin. Never marks anything as read.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { classNameFactory } from "@api/Styles";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";

import { startController, stopController } from "./controller";
import { closeAllStreams } from "./streams";
import { mountRoot, SettingsPanel, unmountRoot } from "./ui";

export const logger = new Logger("PeekAnything");
export const cl = classNameFactory("vc-peek-");

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    /** alt | ctrl | shift | custom */
    key: {
        type: OptionType.STRING,
        description: "Hold key",
        default: "alt",
        hidden: true
    },
    /** KeyboardEvent.code of the custom key */
    customKey: {
        type: OptionType.STRING,
        description: "Custom hold key",
        default: "Backquote",
        hidden: true
    },
    holdDelay: {
        type: OptionType.NUMBER,
        description: "Hold delay in ms",
        default: 150,
        hidden: true
    },
    keepStreamSeconds: {
        type: OptionType.NUMBER,
        description: "Keep stream connected after a peek (seconds)",
        default: 30,
        hidden: true
    },
    muteStream: {
        type: OptionType.BOOLEAN,
        description: "Mute the audio of peeked streams",
        default: true,
        hidden: true
    },
    channels: {
        type: OptionType.BOOLEAN,
        description: "Peek channels, threads & DMs",
        default: true,
        hidden: true
    },
    messageLinks: {
        type: OptionType.BOOLEAN,
        description: "Peek message links",
        default: true,
        hidden: true
    },
    streams: {
        type: OptionType.BOOLEAN,
        description: "Peek streaming users",
        default: true,
        hidden: true
    },
    voiceChannels: {
        type: OptionType.BOOLEAN,
        description: "Peek voice channels",
        default: true,
        hidden: true
    },
    callStreams: {
        type: OptionType.BOOLEAN,
        description: "Peek streams of your current call",
        default: true,
        hidden: true
    },
    /** Position & width of the call stream preview after the user moved/resized it (null = above the chat input) */
    callBox: {
        type: OptionType.CUSTOM,
        default: null as { left: number; top: number; width: number; } | null,
        hidden: true
    }
});

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "PeekAnything",
    description: "Hold Alt to peek at channels, DMs, message links, streams and voice channels under the mouse - without opening them or marking them read",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Chat", "Voice", "Utility"],
    settings,

    start() {
        mountRoot();
        startController();
    },

    stop() {
        stopController();
        unmountRoot();
        closeAllStreams();
    }
});
