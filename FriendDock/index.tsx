/*
 * FriendDock – Vencord Userplugin
 * A dock of your favorite friends with live status, activity and voice channel - join their voice channel
 * with one click or follow them so you automatically move along when they switch channels.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, User } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import {
    AuthenticationStore, ChannelStore, GuildStore, Menu, PermissionsBits, PermissionStore, RelationshipStore,
    SelectedChannelStore, showToast, Toasts, UserStore, VoiceStateStore
} from "@webpack/common";

import { renderTitleBarButton, SettingsPanel } from "./ui";

export const logger = new Logger("FriendDock");

/** Same module userVoiceShow uses to join voice channels */
const ChannelActions = findByPropsLazy("selectVoiceChannel", "selectChannel");

/** How long to wait after the followed friend moved before moving along (they sometimes hop quickly) */
const FOLLOW_DELAY = 400;

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
    sortByStatus: {
        type: OptionType.BOOLEAN,
        description: "Sort the dock by status (in voice, online, idle, ... offline) instead of your own order",
        default: true,
        hidden: true
    },
    hideOffline: {
        type: OptionType.BOOLEAN,
        description: "Hide offline friends in the dock",
        default: false,
        hidden: true
    },
    leaveWithFriend: {
        type: OptionType.BOOLEAN,
        description: "While following: leave the voice channel when the friend leaves voice",
        default: false,
        hidden: true
    },
    /** Favorite user ids, in the user's own order */
    favorites: {
        type: OptionType.CUSTOM,
        default: [] as string[],
        hidden: true
    },
    /** User id that is currently followed in voice (reset on every start) */
    following: {
        type: OptionType.CUSTOM,
        default: null as string | null,
        hidden: true
    }
});

// ---------------------------------------------------------------- Favorites

export const isFavorite = (id: string) => settings.store.favorites.includes(id);

export function addFavorite(id: string) {
    if (!isFavorite(id)) settings.store.favorites = [...settings.store.favorites, id];
}

export function removeFavorite(id: string) {
    settings.store.favorites = settings.store.favorites.filter(f => f !== id);
    if (settings.store.following === id) stopFollowing();
}

export function moveFavorite(id: string, delta: number) {
    const list = [...settings.store.favorites];
    const from = list.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]];
    settings.store.favorites = list;
}

export function getDisplayName(user: User | undefined, id: string) {
    if (!user) return `Unknown user (${id})`;
    return RelationshipStore.getNickname(user.id) || (user as any).globalName || user.username;
}

// ---------------------------------------------------------------- Voice

export interface VoiceInfo {
    channel: Channel;
    channelName: string;
    /** Server name, or "Direct call" / "Group call" */
    place: string;
    count: number;
    isPrivate: boolean;
}

export function getVoiceInfo(channelId: string | null | undefined): VoiceInfo | null {
    if (!channelId) return null;
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return null;

    const count = Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {}).length;

    if (channel.isDM()) return { channel, channelName: "Call", place: "Direct call", count, isPrivate: true };
    if (channel.isMultiUserDM()) return { channel, channelName: channel.name || "Group", place: "Group call", count, isPrivate: true };

    const guild = GuildStore.getGuild(channel.guild_id);
    return { channel, channelName: channel.name, place: guild?.name ?? "Unknown server", count, isPrivate: false };
}

export const getMyVoiceChannelId = () => SelectedChannelStore.getVoiceChannelId() ?? null;

/** Why the channel can't be joined, or null if it can */
export function getJoinBlocker(channelId: string): string | null {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return "You can't see this voice channel.";
    if (channel.isDM() || channel.isMultiUserDM()) return null;

    if (!PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel)) return "You can't see this voice channel.";
    if (!PermissionStore.can(PermissionsBits.CONNECT, channel)) return `You don't have permission to join #${channel.name}.`;

    const limit = channel.userLimit;
    if (limit > 0 && !PermissionStore.can(PermissionsBits.MOVE_MEMBERS, channel)) {
        const count = Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {}).length;
        if (count >= limit) return `#${channel.name} is full.`;
    }
    return null;
}

/** The channel we moved into ourselves - used to tell our own moves apart from the user's */
let expectedChannelId: string | null | undefined;

/** Join a voice channel; shows a toast and returns false if that's not possible */
export function joinVoice(channelId: string, quiet = false): boolean {
    if (getMyVoiceChannelId() === channelId) return true;

    const blocker = getJoinBlocker(channelId);
    if (blocker) {
        showToast(blocker, Toasts.Type.FAILURE);
        return false;
    }

    try {
        expectedChannelId = channelId;
        ChannelActions.selectVoiceChannel(channelId);
        if (!quiet) {
            const info = getVoiceInfo(channelId);
            if (info) showToast(`Joining ${info.isPrivate ? info.place : "#" + info.channelName}`, Toasts.Type.SUCCESS);
        }
        return true;
    } catch (e) {
        expectedChannelId = undefined;
        logger.error("Failed to join voice channel", e);
        showToast("Failed to join the voice channel.", Toasts.Type.FAILURE);
        return false;
    }
}

function leaveVoice() {
    try {
        expectedChannelId = null;
        if (typeof ChannelActions.disconnect === "function") ChannelActions.disconnect();
        else ChannelActions.selectVoiceChannel(null);
    } catch (e) {
        expectedChannelId = undefined;
        logger.error("Failed to leave voice channel", e);
    }
}

// ---------------------------------------------------------------- Follow

let followTimer: ReturnType<typeof setTimeout> | undefined;
/** Our own voice channel as last seen - only real channel changes count, not mute/deafen updates */
let myLastChannelId: string | null = null;

const followedName = () => {
    const id = settings.store.following;
    return id ? getDisplayName(UserStore.getUser(id), id) : "";
};

export function startFollowing(id: string) {
    if (id === UserStore.getCurrentUser()?.id) return;
    settings.store.following = id;
    myLastChannelId = getMyVoiceChannelId();

    const name = getDisplayName(UserStore.getUser(id), id);
    const channelId = VoiceStateStore.getVoiceStateForUser(id)?.channelId;

    if (!channelId) {
        showToast(`Following ${name} - you'll join when they join voice.`, Toasts.Type.MESSAGE);
        return;
    }
    if (channelId === getMyVoiceChannelId()) {
        showToast(`Following ${name}.`, Toasts.Type.SUCCESS);
        return;
    }
    if (joinVoice(channelId, true)) showToast(`Following ${name}.`, Toasts.Type.SUCCESS);
    else stopFollowing(true);
}

export function stopFollowing(quiet = false, reason?: string) {
    const name = followedName();
    clearTimeout(followTimer);
    expectedChannelId = undefined;
    if (!settings.store.following) return;
    settings.store.following = null;
    if (!quiet) showToast(reason ?? `Stopped following ${name}.`, Toasts.Type.MESSAGE);
}

export function toggleFollow(id: string) {
    if (settings.store.following === id) stopFollowing();
    else startFollowing(id);
}

/** Move to wherever the followed friend is right now */
function syncWithFollowed() {
    const id = settings.store.following;
    if (!id) return;

    const channelId = VoiceStateStore.getVoiceStateForUser(id)?.channelId ?? null;
    const mine = getMyVoiceChannelId();
    if (channelId === mine) return;

    if (channelId) {
        if (!joinVoice(channelId, true)) {
            stopFollowing(true);
            return;
        }
        const info = getVoiceInfo(channelId);
        showToast(`Following ${followedName()} to ${info ? (info.isPrivate ? info.place : "#" + info.channelName) : "their channel"}`, Toasts.Type.MESSAGE);
    } else if (mine && settings.store.leaveWithFriend) {
        showToast(`${followedName()} left voice - leaving too.`, Toasts.Type.MESSAGE);
        leaveVoice();
    }
}

interface VoiceStateChange {
    userId: string;
    channelId?: string | null;
    oldChannelId?: string | null;
    sessionId?: string;
}

function onVoiceStateUpdates({ voiceStates }: { voiceStates: VoiceStateChange[]; }) {
    const followed = settings.store.following;
    if (!followed || !voiceStates?.length) return;

    const myId = UserStore.getCurrentUser()?.id;

    for (const vs of voiceStates) {
        if (vs.userId === followed) {
            // Let the stores settle and ignore quick hops, then go where they are now
            clearTimeout(followTimer);
            followTimer = setTimeout(syncWithFollowed, FOLLOW_DELAY);
        } else if (vs.userId === myId && vs.sessionId === AuthenticationStore.getSessionId()) {
            const newChannel = vs.channelId ?? null;
            if (newChannel === myLastChannelId) continue;
            myLastChannelId = newChannel;

            if (expectedChannelId !== undefined && newChannel === expectedChannelId) {
                // Our own move arrived
                expectedChannelId = undefined;
                continue;
            }
            // The user moved or left on their own (or was moved) - don't fight them
            const friendChannel = VoiceStateStore.getVoiceStateForUser(followed)?.channelId ?? null;
            if (newChannel !== friendChannel) {
                stopFollowing(false, newChannel
                    ? `You switched channels - stopped following ${followedName()}.`
                    : `You left voice - stopped following ${followedName()}.`);
            }
        }
    }
}

// ---------------------------------------------------------------- Context menu

const UserContext: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user || user.id === UserStore.getCurrentUser()?.id) return;

    const fav = isFavorite(user.id);
    const following = settings.store.following === user.id;

    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem
            id="vc-frienddock-toggle"
            label={fav ? "Remove from Friend Dock" : "Add to Friend Dock"}
            action={() => fav ? removeFavorite(user.id) : addFavorite(user.id)}
        />,
        <Menu.MenuItem
            id="vc-frienddock-follow"
            label={following ? "Stop following in voice" : "Follow in voice"}
            action={() => toggleFollow(user.id)}
        />
    );
};

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "FriendDock",
    description: "A dock of your favorite friends with live status, activity and voice channel - join with one click or follow them through voice channels",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Friends", "Voice", "Utility"],
    settings,

    patches: [
        {
            // Left side of the title bar (next to Back/Forward & Inbox): append the button at the end.
            // Other plugins patch the same spot - each appends its own button, order = plugin load order.
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,2500}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        }
    ],

    renderTitleBarButton,

    contextMenus: {
        "user-context": UserContext
    },

    flux: {
        VOICE_STATE_UPDATES: onVoiceStateUpdates
    },

    toolboxActions: {
        "Stop following": () => stopFollowing()
    },

    start() {
        // Following is only meant for the current session
        settings.store.following = null;
    },

    stop() {
        clearTimeout(followTimer);
        expectedChannelId = undefined;
        settings.store.following = null;
    }
});
