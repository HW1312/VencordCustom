/*
 * ServerDeclutter – Vencord Userplugin
 * Overview of all servers with local activity tracking – mute, mark as read, archive or leave.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, Menu, SelectedGuildStore, UserStore } from "@webpack/common";

import { cancelAll } from "./actions";
import { openDeclutterModal } from "./DeclutterModal";
import { flushActivity, loadActivity, recordOpened, recordWrote } from "./store";
import { SettingsPanel } from "./ui";

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    tracking: {
        type: OptionType.BOOLEAN,
        description: "Track activity locally",
        default: true,
        hidden: true
    },
    staleDays: {
        type: OptionType.NUMBER,
        description: "\"Not opened\" after (days)",
        default: 90,
        hidden: true
    },
    deadDays: {
        type: OptionType.NUMBER,
        description: "\"Dead\" after (days without messages)",
        default: 30,
        hidden: true
    },
    archiveFolderName: {
        type: OptionType.STRING,
        description: "Archive folder name",
        default: "Archive",
        hidden: true
    },
    requestInterval: {
        type: OptionType.NUMBER,
        description: "Minimum interval between actions (ms)",
        default: 1000,
        hidden: true
    },
    leaveInterval: {
        type: OptionType.NUMBER,
        description: "Minimum interval when leaving (ms)",
        default: 2000,
        hidden: true
    }
});

// ---------------------------------------------------------------- Tracking

let running = false;

function onChannelSelect({ guildId }: { guildId?: string | null; }) {
    if (!running || !settings.store.tracking || !guildId || guildId === "@me") return;
    recordOpened(guildId);
}

function onMessageCreate({ message, guildId, optimistic }: { message?: any; guildId?: string; optimistic?: boolean; }) {
    if (!running || !settings.store.tracking || optimistic || !message) return;
    const me = UserStore.getCurrentUser()?.id;
    if (!me || message.author?.id !== me) return;
    const gid = guildId ?? message.guild_id ?? ChannelStore.getChannel(message.channel_id)?.guild_id;
    if (gid) recordWrote(gid);
}

// ---------------------------------------------------------------- Context menu

const guildContextPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: { id: string; }; }) => {
    if (!guild?.id) return;
    const group = findGroupChildrenByChildId("privacy", children) ?? children;
    group.push(
        <Menu.MenuItem id="vc-serverdeclutter" label="Declutter servers …" action={() => openDeclutterModal(guild.id)} />
    );
};

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "ServerDeclutter",
    description: "Declutter servers: overview of all servers with local activity tracking, filters and suggestions – mute, mark as read, archive or leave",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Servers", "Utility"],
    settings,

    contextMenus: {
        "guild-context": guildContextPatch
    },

    toolboxActions: {
        "Declutter servers …": () => openDeclutterModal()
    },

    flux: {
        CHANNEL_SELECT: onChannelSelect,
        MESSAGE_CREATE: onMessageCreate
    },

    start() {
        running = true;
        void loadActivity().then(() => {
            // The currently open server counts as opened
            const current = SelectedGuildStore.getGuildId();
            if (running && current && settings.store.tracking) recordOpened(current);
        });
    },

    stop() {
        running = false;
        cancelAll();
        void flushActivity();
    }
});
