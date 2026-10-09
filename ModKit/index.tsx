/*
 * ModKit – Vencord Userplugin
 * Moderation toolkit for mod teams: ModNotes via a private mod channel, mod macros and a scam quick action.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, GuildRoleStore, Menu, PermissionsBits, PermissionStore, SelectedGuildStore, showToast, UserStore } from "@webpack/common";
import type { ReactElement } from "react";

import { getMacros, hasAnyModPermission, Macro, makePresets, stepProblem, targetFromMessage } from "./macros";
import { clearStored, ensureLoaded, getNotesChannelId, getNotesForUser, isNotesChannel, onMessageCreate, onMessageDelete, onMessageUpdate, resetAll } from "./notes";
import { clearScamCache } from "./scam";
import { MemberListBadge, MessageBadge, ModKitIcon, openNotesModal, openQuickPick, runOrConfirm, ScamAccessory, SettingsPanel } from "./ui";

// ---------------------------------------------------------------- Settings

export type BadgeMode = "warn" | "all";

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    /** Server ID -> channel ID of the ModNotes channel */
    notesChannels: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, string>
    },
    /** Mod macros (null = never edited -> presets) */
    macros: {
        type: OptionType.CUSTOM,
        default: null as Macro[] | null
    },
    showBadgeChat: {
        type: OptionType.BOOLEAN,
        description: "Warning badge next to names in chat",
        default: true,
        hidden: true
    },
    showBadgeMemberList: {
        type: OptionType.BOOLEAN,
        description: "Warning badge in the member list",
        default: true,
        hidden: true
    },
    badgeMode: {
        type: OptionType.STRING,
        description: "What the badge counts (warn / all)",
        default: "warn" as BadgeMode,
        hidden: true
    },
    showPopoverButton: {
        type: OptionType.BOOLEAN,
        description: "ModKit button on messages (on hover)",
        default: true,
        hidden: true
    },
    scamDetector: {
        type: OptionType.BOOLEAN,
        description: "Flag possible scam links",
        default: true,
        hidden: true
    }
});

// ---------------------------------------------------------------- Context menus

const TEXT_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);

const channelContext: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel?.guild_id || !TEXT_CHANNEL_TYPES.has(channel.type)) return;
    // Only offer if the user can read and write there
    if (!PermissionStore.can(PermissionsBits.VIEW_CHANNEL | PermissionsBits.SEND_MESSAGES | PermissionsBits.READ_MESSAGE_HISTORY, channel)) return;

    const guildId: string = channel.guild_id;
    const isCurrent = getNotesChannelId(guildId) === channel.id;

    children.push(
        <Menu.MenuItem
            id="vc-modkit-set-notes-channel"
            label={isCurrent ? "Remove ModNotes channel" : "Set as ModNotes channel"}
            color={isCurrent ? "danger" : undefined}
            leadingAccessory={{ type: "icon", icon: ModKitIcon }}
            action={() => isCurrent ? unsetNotesChannel(guildId) : setNotesChannel(guildId, channel)}
        />
    );
};

export function setNotesChannel(guildId: string, channel: any) {
    const old = getNotesChannelId(guildId);
    if (old && old !== channel.id) void clearStored(old);
    settings.store.notesChannels = { ...settings.store.notesChannels, [guildId]: channel.id };
    showToast(`ModKit: #${channel.name} is now the ModNotes channel`, "success");

    if (isPubliclyVisible(guildId, channel))
        setTimeout(() => showToast("ModKit: Warning - this channel appears to be visible to @everyone!", "failure"), 1200);
}

export function unsetNotesChannel(guildId: string) {
    const old = getNotesChannelId(guildId);
    if (old) void clearStored(old);
    const next = { ...settings.store.notesChannels };
    delete next[guildId];
    settings.store.notesChannels = next;
    showToast("ModKit: ModNotes channel removed", "message");
}

/** Rough check: can @everyone see the channel? */
function isPubliclyVisible(guildId: string, channel: any) {
    try {
        const view = PermissionsBits.VIEW_CHANNEL;
        const everyone = GuildRoleStore.getRole(guildId, guildId);
        const base = everyone?.permissions != null ? (BigInt(everyone.permissions) & view) !== 0n : true;
        const ow = channel.permissionOverwrites?.[guildId];
        if (ow && (BigInt(ow.deny) & view) !== 0n) return false;
        if (ow && (BigInt(ow.allow) & view) !== 0n) return true;
        return base;
    } catch {
        return false;
    }
}

const userContext: NavContextMenuPatchCallback = (children, props) => {
    const { user } = props ?? {};
    if (!user?.id) return;
    const guildId: string | undefined = props.guildId ?? props.channel?.guild_id ?? SelectedGuildStore.getGuildId();
    if (!guildId || !getNotesChannelId(guildId)) return;

    void ensureLoaded(guildId);
    const count = getNotesForUser(guildId, user.id).length;

    children.push(
        <Menu.MenuItem
            id="vc-modkit-notes"
            label={`ModNotes (${count})`}
            leadingAccessory={{ type: "icon", icon: ModKitIcon }}
            action={() => openNotesModal(guildId, user.id)}
        />
    );
};

const messageContext: NavContextMenuPatchCallback = (children, { message, channel }) => {
    if (!message?.author || !channel?.guild_id) return;
    if (message.author.id === UserStore.getCurrentUser()?.id) return;

    const guildId: string = channel.guild_id;
    const notesChannel = getNotesChannelId(guildId);
    const modPerm = hasAnyModPermission(channel);
    if (!modPerm && !notesChannel) return;

    const target = targetFromMessage(message, channel);
    const items: ReactElement[] = [];

    if (modPerm) {
        for (const macro of getMacros()) {
            const problems = macro.steps.map(s => stepProblem(s, target));
            const allBlocked = macro.steps.length === 0 || problems.every(p => p != null);
            items.push(
                <Menu.MenuItem
                    id={`vc-modkit-macro-${macro.id}`}
                    key={macro.id}
                    label={`${macro.emoji} ${macro.name}`}
                    subtext={allBlocked ? (problems.find(Boolean) ?? "No steps") : undefined}
                    disabled={allBlocked}
                    action={() => runOrConfirm(macro, target)}
                />
            );
        }
    }

    if (notesChannel) {
        void ensureLoaded(guildId);
        if (items.length) items.push(<Menu.MenuSeparator key="sep" />);
        items.push(
            <Menu.MenuItem
                id="vc-modkit-msg-notes"
                key="notes"
                label={`ModNotes (${getNotesForUser(guildId, message.author.id).length})`}
                action={() => openNotesModal(guildId, message.author.id, target)}
            />
        );
    }

    if (!items.length) return;

    children.push(
        <Menu.MenuItem id="vc-modkit" label="ModKit" leadingAccessory={{ type: "icon", icon: ModKitIcon }}>
            {items}
        </Menu.MenuItem>
    );
};

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "ModKit",
    description: "Moderation toolkit: ModNotes via a private mod channel, mod macros (delete, timeout, kick, ban, reply, note) and a scam quick action",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Utility", "Chat"],
    settings,

    contextMenus: {
        "channel-context": channelContext,
        "thread-context": channelContext,
        "user-context": userContext,
        "message": messageContext
    },

    messagePopoverButton: {
        icon: ModKitIcon,
        render(msg) {
            if (!settings.store.showPopoverButton) return null;
            const channel = ChannelStore.getChannel(msg.channel_id);
            if (!channel?.guild_id || !msg.author || msg.author.id === UserStore.getCurrentUser()?.id) return null;
            if (!hasAnyModPermission(channel)) return null;

            return {
                label: "ModKit",
                icon: ModKitIcon,
                message: msg,
                channel,
                onClick: () => openQuickPick(msg, channel)
            };
        }
    },

    renderMessageAccessory: props => <ScamAccessory message={props.message} />,
    renderMessageDecoration: props => <MessageBadge message={props.message} channel={props.channel} />,
    renderMemberListDecorator: props => props.type === "guild" && props.user ? <MemberListBadge userId={props.user.id} /> : null,

    flux: {
        MESSAGE_CREATE({ channelId, message, optimistic }: { channelId: string; message: any; optimistic: boolean; }) {
            if (!optimistic && channelId && isNotesChannel(channelId)) onMessageCreate(channelId, message);
        },
        MESSAGE_UPDATE({ message }: { message: any; }) {
            if (message?.channel_id && isNotesChannel(message.channel_id)) onMessageUpdate(message);
        },
        MESSAGE_DELETE({ id, channelId }: { id: string; channelId: string; }) {
            if (channelId && isNotesChannel(channelId)) onMessageDelete(channelId, [id]);
        },
        MESSAGE_DELETE_BULK({ ids, channelId }: { ids: string[]; channelId: string; }) {
            if (channelId && isNotesChannel(channelId)) onMessageDelete(channelId, ids ?? []);
        }
    },

    start() {
        if (!Array.isArray(settings.store.macros)) settings.store.macros = makePresets();
    },

    stop() {
        resetAll();
        clearScamCache();
    }
});
