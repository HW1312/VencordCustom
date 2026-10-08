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
    }
});
