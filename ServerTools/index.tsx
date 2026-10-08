/*
 * ServerTools – Vencord Userplugin
 * Tools for server owners: backup & restore, channel activity and fair, verifiable giveaways.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Menu } from "@webpack/common";

import { openBackupModal } from "./BackupModal";
import { openGiveawayModal } from "./GiveawayModal";
import { openHealthModal } from "./HealthModal";
import { openNameCopyModal } from "./NameCopyModal";
import { cancelAll, queueConfig } from "./queue";
import { SettingsPanel } from "./ui";

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    requestInterval: {
        type: OptionType.NUMBER,
        description: "Minimum interval between API requests (ms)",
        default: 1000,
        hidden: true,
        onChange: (v: number) => queueConfig.interval = Math.max(1000, Number(v) || 1000)
    },
    healthDays: {
        type: OptionType.NUMBER,
        description: "Channel Health: time range in days",
        default: 30,
        hidden: true
    },
    healthMaxPerChannel: {
        type: OptionType.NUMBER,
        description: "Channel Health: max. messages per channel",
        default: 2000,
        hidden: true
    }
});

// ---------------------------------------------------------------- Context menus

const guildContextPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: { id: string; }; }) => {
    if (!guild?.id) return;
    const group = findGroupChildrenByChildId("privacy", children) ?? children;
    group.push(
        <Menu.MenuItem id="vc-servertools" label="ServerTools">
            <Menu.MenuItem id="vc-servertools-backup" label="Backup" action={() => openBackupModal(guild.id, "export")} />
            <Menu.MenuItem id="vc-servertools-restore" label="Restore backup" action={() => openBackupModal(guild.id, "restore")} />
            <Menu.MenuItem id="vc-servertools-health" label="Channel Health" action={() => openHealthModal(guild.id)} />
        </Menu.MenuItem>
    );
};

const channelContextPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: { name?: string; type?: number; }; }) => {
    if (!channel?.name) return;
    const group = findGroupChildrenByChildId("copy-channel-link", children)
        ?? findGroupChildrenByChildId("devmode-copy-id", children)
        ?? children;
    group.push(
        <Menu.MenuItem id="vc-servertools-copy-name" label="Copy name…" action={() => openNameCopyModal(channel)} />
    );
};

const messageContextPatch: NavContextMenuPatchCallback = (children, { message }: { message?: any; }) => {
    if (!message?.reactions?.length) return;
    const group = findGroupChildrenByChildId("copy-link", children) ?? children;
    group.push(
        <Menu.MenuItem id="vc-servertools-giveaway" label="Draw giveaway" action={() => openGiveawayModal(message)} />
    );
};

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "ServerTools",
    description: "Server tools: backup & restore, Channel Health with heatmap, fair, verifiable giveaways and copying channel names",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Servers", "Utility"],
    settings,

    contextMenus: {
        "guild-context": guildContextPatch,
        "channel-context": channelContextPatch,
        "thread-context": channelContextPatch,
        "message": messageContextPatch
    },

    start() {
        queueConfig.interval = Math.max(1000, settings.store.requestInterval || 1000);
    },

    stop() {
        // Immediately cancel running backups, analyses and downloads
        cancelAll();
    }
});
