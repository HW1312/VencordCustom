/*
 * ToolbarManager – Vencord Userplugin
 * Tidies up the chat bar and title bar: sort, hide or move buttons into a ⋯ menu.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { showToast } from "@webpack/common";

import { titleBarSlot } from "../_ui";
import { hitTest, startDom, stopDom } from "./dom";
import { flush, loadData, logger, runtime } from "./store";
import { ChatDockButton, ChatDockIcon, openItemMenu, openManagerModal, renderTitleBarButton, SettingsPanel } from "./ui";

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    contextMenu: {
        type: OptionType.SELECT,
        description: "Quick menu on buttons",
        options: [
            { label: "Right-click", value: "right", default: true },
            { label: "Shift + right-click", value: "shift" },
            { label: "Off", value: "off" }
        ],
        hidden: true
    }
});

// ---------------------------------------------------------------- Right-click

/*
 * Capturing listener on document: only acts if the target is inside a button of the chat bar or
 * title bar that we have marked. All other Discord context menus are left untouched.
 */
function onContextMenu(e: MouseEvent) {
    const mode = settings.store.contextMenu;
    if (mode === "off") return;
    if (mode === "shift" ? !e.shiftKey : e.shiftKey) return;

    const hit = hitTest(e.target);
    if (!hit) return;

    e.preventDefault();
    e.stopPropagation();
    openItemMenu(e, hit);
}

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "ToolbarManager",
    description: "Tidies up the chat bar and title bar: sort, hide or move buttons into a ⋯ menu - with profiles",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Appearance", "Utility"],
    settings,

    patches: [
        {
            // Title bar on the left (next to Back/Forward & Inbox): append our own ⋯ button at the end (like FakeMute)
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,2500}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        }
    ],

    renderTitleBarButton: titleBarSlot("ToolbarManager", renderTitleBarButton),

    chatBarButton: {
        icon: ChatDockIcon,
        render: ChatDockButton
    },

    toolboxActions: {
        "Manage toolbar": () => openManagerModal()
    },

    async start() {
        runtime.running = true;
        await loadData();
        if (!runtime.running) return;
        try {
            startDom();
        } catch (e) {
            logger.error("Failed to start", e);
            showToast("ToolbarManager: Failed to start - see console for details", "failure");
        }
        document.addEventListener("contextmenu", onContextMenu, true);
    },

    stop() {
        runtime.running = false;
        document.removeEventListener("contextmenu", onContextMenu, true);
        stopDom();
        flush();
    }
});
