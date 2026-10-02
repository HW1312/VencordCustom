/*
 * Wrapped – Vencord Userplugin
 * Your personal Discord statistics: voice time, messages, active time, games and the people you spend time with.
 * Everything is tracked locally from installation on and only stored on this device.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

import { cancelBackfill, loadAllTime } from "./backfill";
import { onMessageCreate, startTracking, stopTracking } from "./tracker";
import { openWrappedModal, renderTitleBarButton, SettingsPanel } from "./ui";

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    showTitleBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show icon in the title bar",
        default: true,
        hidden: true
    },
    trackMessages: {
        type: OptionType.BOOLEAN,
        description: "Track messages",
        default: true,
        hidden: true
    },
    trackVoice: {
        type: OptionType.BOOLEAN,
        description: "Track voice time",
        default: true,
        hidden: true
    },
    trackActive: {
        type: OptionType.BOOLEAN,
        description: "Track active time",
        default: true,
        hidden: true
    },
    trackGames: {
        type: OptionType.BOOLEAN,
        description: "Track games",
        default: true,
        hidden: true
    },
    idleMinutes: {
        type: OptionType.NUMBER,
        description: "Idle after (minutes without input)",
        default: 5,
        hidden: true
    }
});

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "Wrapped",
    description: "Your personal Discord Wrapped: voice time, messages, active hours, games, top people and servers – tracked locally",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Fun", "Utility"],
    settings,

    patches: [
        {
            // Left side of the title bar (next to Back/Forward & Inbox): append the button at the end
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,2500}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        }
    ],

    renderTitleBarButton,

    toolboxActions: {
        "My Wrapped": () => openWrappedModal()
    },

    flux: {
        MESSAGE_CREATE: onMessageCreate
    },

    start() {
        startTracking();
        void loadAllTime();
    },

    stop() {
        cancelBackfill();
        stopTracking();
    }
});
