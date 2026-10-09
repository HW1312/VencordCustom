/*
 * PluginHub – Vencord Userplugin
 * Toggle all your own plugins on and off in one place instead of hunting for them in the Vencord list,
 * and install / apply the themes from the Themes folder (Theme Hub tab).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotice } from "@api/Notices";
import { isPluginEnabled, pluginRequiresRestart, plugins, startDependenciesRecursive, startPlugin, stopPlugin } from "@api/PluginManager";
import { definePluginSettings, Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, Plugin } from "@utils/types";
import { showToast } from "@webpack/common";

import added from "./added.json";
import { openHubModal, renderTitleBarButton, SettingsPanel } from "./ui";

export const logger = new Logger("PluginHub");

/** Own plugins are recognized by author, so new plugins show up automatically */
const OWN_AUTHOR = "5406";
/** How long a plugin counts as new after it was added (as long as it hasn't been tried) */
const NEW_FOR = 7 * 24 * 60 * 60 * 1000;

/** Plugin name → time it was added, written by build.mjs */
const addedAt = added as Record<string, number>;

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
    sort: {
        type: OptionType.SELECT,
        description: "Sort order",
        options: [
            { label: "Newest first", value: "new", default: true },
            { label: "A–Z", value: "az" }
        ],
        hidden: true
    },
    /** Last open tab of the hub */
    tab: {
        type: OptionType.SELECT,
        description: "Open tab",
        options: [
            { label: "Plugins", value: "plugins", default: true },
            { label: "Themes", value: "themes" }
        ],
        hidden: true
    },
    /** Plugins that were turned on at least once – they lose their NEW badge */
    tried: {
        type: OptionType.CUSTOM,
        default: [] as string[],
        hidden: true
    }
});

// ---------------------------------------------------------------- Plugins

export function getOwnPlugins(): Plugin[] {
    return Object.values(plugins)
        .filter(p => p.name !== "PluginHub" && p.authors?.some(a => a.name === OWN_AUTHOR))
        .sort((a, b) =>
            (settings.store.sort === "new" ? (addedAt[b.name] ?? 0) - (addedAt[a.name] ?? 0) : 0)
            || a.name.localeCompare(b.name)
        );
}

export const isEnabled = (p: Plugin) => isPluginEnabled(p.name);

export function isNew(p: Plugin) {
    const at = addedAt[p.name];
    return !!at && Date.now() - at < NEW_FOR && !isEnabled(p) && !settings.store.tried.includes(p.name);
}

export function markTried(p: Plugin) {
    if (!settings.store.tried.includes(p.name))
        settings.store.tried = [...settings.store.tried, p.name];
}

/** Setting and actual state differ → only takes effect after a restart */
export const needsRestart = (p: Plugin) => pluginRequiresRestart(p) && isEnabled(p) !== !!p.started;

/** Same logic as Vencord's own plugin card */
export function setEnabled(p: Plugin, enable: boolean) {
    const wasEnabled = isEnabled(p);
    if (wasEnabled === enable) return;
    if (enable) markTried(p);

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
        showToast(`Failed to ${enable ? "start" : "stop"} ${p.name}`, "failure");
        return;
    }

    pluginSettings.enabled = enable;
}

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "PluginHub",
    description: "Toggle all your own plugins and install or apply themes in one place – via the title bar or the settings",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Utility"],
    settings,

    patches: [
        {
            // Left side of the title bar (next to Back/Forward & Inbox): append the button at the end.
            // Order of plugin icons = plugin load order (alphabetical by folder).
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,2500}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        }
    ],

    renderTitleBarButton,

    toolboxActions: {
        "Plugin Hub": () => openHubModal()
    }
});
