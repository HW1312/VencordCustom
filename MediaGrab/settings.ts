/*
 * MediaGrab – Settings (own module so ui.tsx / grab.ts don't import index.tsx)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    showChatBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show the MediaGrab button in the chat bar",
        default: true
    },
    menuQuality: {
        type: OptionType.SELECT,
        description: "Video quality for the right-click menu",
        options: [
            { label: "Best available", value: 0 },
            { label: "1080p", value: 1080 },
            { label: "720p (smaller files, good for the chat)", value: 720, default: true },
            { label: "480p", value: 480 }
        ]
    },
    cookiesFrom: {
        type: OptionType.SELECT,
        description: "Use the login of a browser (for age-restricted or private videos, e.g. Instagram). Chrome / Edge usually refuse this while they are open (then it downloads without login), Firefox works best.",
        options: [
            { label: "Off", value: "none", default: true },
            { label: "Firefox", value: "firefox" },
            { label: "Chrome", value: "chrome" },
            { label: "Edge", value: "edge" },
            { label: "Brave", value: "brave" },
            { label: "Opera", value: "opera" }
        ]
    },
    // Last choices in the window
    lastKind: { type: OptionType.STRING, description: "", default: "video", hidden: true },
    lastQuality: { type: OptionType.NUMBER, description: "", default: 720, hidden: true },
    lastToChat: { type: OptionType.BOOLEAN, description: "", default: true, hidden: true },
    lastToDisk: { type: OptionType.BOOLEAN, description: "", default: false, hidden: true }
});
