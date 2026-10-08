/*
 * SecretChat – Settings (own module so ui.tsx / messages.ts don't import index.tsx)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    showChatBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show the lock button in the chat bar (click: choose a key, right-click: on / off)",
        default: true
    },
    showLockIcon: {
        type: OptionType.BOOLEAN,
        description: "Show a small lock next to the name on decrypted messages",
        default: true
    },
    showServerListIcon: {
        type: OptionType.BOOLEAN,
        description: "Show the SecretChat icon with your secret rooms in the server list",
        default: true
    },
    showTitleBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show the SecretChat icon in the title bar at the top (next to Back / Forward)",
        default: true
    },
    roomPings: {
        type: OptionType.BOOLEAN,
        description: "Ping (sound + notification) for new messages in secret rooms – Discord's own notifications are always off there",
        default: true
    }
});
