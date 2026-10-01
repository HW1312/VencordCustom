/*
 * PluginHub – Vencord Userplugin
 * Toggle all your own plugins on and off in one place instead of hunting for them in the Vencord list.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotice } from "@api/Notices";
import { isPluginEnabled, pluginRequiresRestart, plugins, startDependenciesRecursive, startPlugin, stopPlugin } from "@api/PluginManager";
import { definePluginSettings, Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, Plugin } from "@utils/types";
import { showToast, Toasts } from "@webpack/common";

import { openHubModal, renderTitleBarButton, SettingsPanel } from "./ui";

export const logger = new Logger("PluginHub");

/** Own plugins are recognized by author, so new plugins show up automatically */
const OWN_AUTHOR = "5406";

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
    }
});

// ---------------------------------------------------------------- Plugins

export function getOwnPlugins(): Plugin[] {
    return Object.values(plugins)
        .filter(p => p.name !== "PluginHub" && p.authors?.some(a => a.name === OWN_AUTHOR))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export const isEnabled = (p: Plugin) => isPluginEnabled(p.name);

/** Setting and actual state differ → only takes effect after a restart */
export const needsRestart = (p: Plugin) => pluginRequiresRestart(p) && isEnabled(p) !== !!p.started;

/** Same logic as Vencord's own plugin card */
export function setEnabled(p: Plugin, enable: boolean) {
    const wasEnabled = isEnabled(p);
    if (wasEnabled === enable) return;

    const pluginSettings = Settings.plugins[p.name];

    if (enable) {
        const { restartNeeded, failures } = startDependenciesRecursive(p);
        if (failures.length) {
            logger.error(`Failed to start dependencies of ${p.name}: ${failures.join(", ")}`);
            showNotice(`Failed to start dependencies: ${failures.join(", ")}`, "Close", () => null);
            return;
        }
        if (restartNeeded) {
            pluginSettings.enabled = true;
            return;
        }
    }

    // Plugins with patches only actually toggle after a restart
    if (pluginRequiresRestart(p) || (wasEnabled && !p.started)) {
        pluginSettings.enabled = enable;
        return;
    }

    const ok = enable ? startPlugin(p) : stopPlugin(p);
    if (!ok) {
        pluginSettings.enabled = false;
        showToast(`Failed to ${enable ? "start" : "stop"} ${p.name}`, Toasts.Type.FAILURE);
        return;
    }

    pluginSettings.enabled = enable;
}

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "PluginHub",
    description: "Toggle all your own plugins on and off in one place – via the title bar or the settings",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Utility"],
    settings,

    patches: [
        {
            // Left side of the title bar (next to Back/Forward & Inbox): append the button at the end.
            // Order of plugin icons = plugin load order (alphabetical by folder).
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,600}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        }
    ],

    renderTitleBarButton,

    toolboxActions: {
        "My Plugins": () => openHubModal()
    }
});
