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
    SelectedChannelStore, showToast, UserStore, VoiceStateStore
} from "@webpack/common";

import { titleBarSlot } from "../_ui";
import { renderTitleBarButton, SettingsPanel } from "./ui";

export const logger = new Logger("FriendDock");

/** Same module userVoiceShow uses to join voice channels */
const ChannelActions = findByPropsLazy("selectVoiceChannel", "selectChannel");

/** How long to wait after the followed friend moved before moving along (they sometimes hop quickly) */
const FOLLOW_DELAY = 400;
/**
 * "Join to create" channels: joining one makes a bot create a channel and move the user into it, usually within a
 * second or two. While the friend sits alone in a channel like that, wait this long for the bot before following -
 * otherwise we'd join the hub too and the bot would give us our own channel.
 */
const HUB_WAIT = 4000;
const HUB_NAME = /create|erstell|join\s*(to|2|for|&)|join\s*here|\bj2c\b|neuer?\s*(channel|kanal|talk)|new\s*(channel|talk|vc)|➕|\+\s*\w/i;
/** Moved back to the friend this many times in a short time (e.g. a bot keeps moving us away): pause until they move */
const MAX_RESYNCS = 3;
const RESYNC_WINDOW = 30_000;

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
        showToast(blocker, "failure");
        return false;
    }

    try {
        expectedChannelId = channelId;
        ChannelActions.selectVoiceChannel(channelId);
        if (!quiet) {
            const info = getVoiceInfo(channelId);
            if (info) showToast(`Joining ${info.isPrivate ? info.place : "#" + info.channelName}`, "success");
        }
        return true;
    } catch (e) {
        expectedChannelId = undefined;
        logger.error("Failed to join voice channel", e);
        showToast("Failed to join the voice channel.", "failure");
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
//
// Following only ends when the user stops it (button, context menu, toolbox) or removes the friend from the dock.
// Moved away (by a bot, an admin or by hand) → back to the friend. Left voice yourself → paused until the friend
// switches channels, then it goes on.

let followTimer: ReturnType<typeof setTimeout> | undefined;
/** Our own voice channel as last seen - only real channel changes count, not mute/deafen updates */
let myLastChannelId: string | null = null;
/** Left voice ourselves (or something keeps moving us away): don't pull back in until the friend moves */
let paused = false;
/** When we moved back to the friend after being moved away */
let resyncs: number[] = [];
/** The friend sits alone in a "join to create" channel since … - waiting for the bot to move them */
let hubWait: { channelId: string; since: number; } | null = null;
/** Channel we already said we can't join - don't repeat the toast every time */
let blockedChannelId: string | null = null;

const followedName = () => {
    const id = settings.store.following;
    return id ? getDisplayName(UserStore.getUser(id), id) : "";
};

const channelLabel = (channelId: string) => {
    const info = getVoiceInfo(channelId);
    return info ? (info.isPrivate ? info.place : "#" + info.channelName) : "their channel";
};

function resetFollowState() {
    clearTimeout(followTimer);
    expectedChannelId = undefined;
    paused = false;
    resyncs = [];
    hubWait = null;
    blockedChannelId = null;
}

/** A "join to create" hub with only the friend in it: a bot is about to move them */
function isCreateHub(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel || channel.isDM() || channel.isMultiUserDM()) return false;
    const count = Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {}).length;
    return count <= 1 && HUB_NAME.test(channel.name ?? "");
}

export function startFollowing(id: string) {
    if (id === UserStore.getCurrentUser()?.id) return;
    resetFollowState();
    settings.store.following = id;
    myLastChannelId = getMyVoiceChannelId();

    const name = getDisplayName(UserStore.getUser(id), id);
    const channelId = VoiceStateStore.getVoiceStateForUser(id)?.channelId;

    if (!channelId) showToast(`Following ${name} - you'll join when they join voice.`, "message");
    else if (channelId === getMyVoiceChannelId()) showToast(`Following ${name}.`, "success");
    else {
        showToast(`Following ${name}.`, "success");
        syncWithFollowed();
    }
}

export function stopFollowing(quiet = false) {
    const name = followedName();
    resetFollowState();
    if (!settings.store.following) return;
    settings.store.following = null;
    if (!quiet) showToast(`Stopped following ${name}.`, "message");
}

export function toggleFollow(id: string) {
    if (settings.store.following === id) stopFollowing();
    else startFollowing(id);
}

function scheduleSync(delay = FOLLOW_DELAY) {
    clearTimeout(followTimer);
    followTimer = setTimeout(syncWithFollowed, delay);
}

/** Move to wherever the followed friend is right now */
function syncWithFollowed() {
    const id = settings.store.following;
    if (!id) return;
    clearTimeout(followTimer);

    const channelId = VoiceStateStore.getVoiceStateForUser(id)?.channelId ?? null;
    const mine = getMyVoiceChannelId();
    if (channelId === mine) {
        hubWait = null;
        return;
    }

    if (!channelId) {
        hubWait = null;
        if (mine && settings.store.leaveWithFriend) {
            showToast(`${followedName()} left voice - leaving too.`, "message");
            leaveVoice();
        }
        return;
    }
    if (paused) return;

    // Don't join a "join to create" hub with them - wait for the bot to move them to their new channel
    if (isCreateHub(channelId)) {
        if (hubWait?.channelId !== channelId) hubWait = { channelId, since: Date.now() };
        if (Date.now() - hubWait.since < HUB_WAIT) {
            scheduleSync(500);
            return;
        }
    }
    hubWait = null;

    const blocker = getJoinBlocker(channelId);
    if (blocker) {
        if (blockedChannelId !== channelId) {
            blockedChannelId = channelId;
            showToast(`${blocker} Still following ${followedName()}.`, "failure");
        }
        return;
    }
    blockedChannelId = null;
    if (joinVoice(channelId, true)) showToast(`Following ${followedName()} to ${channelLabel(channelId)}`, "message");
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
            // They moved: follow again even if we were paused. Let the stores settle and ignore quick hops.
            paused = false;
            resyncs = [];
            scheduleSync();
        } else if (vs.userId === myId && vs.sessionId === AuthenticationStore.getSessionId()) {
            const newChannel = vs.channelId ?? null;
            if (newChannel === myLastChannelId) continue;
            myLastChannelId = newChannel;

            if (expectedChannelId !== undefined && newChannel === expectedChannelId) {
                // Our own move arrived
                expectedChannelId = undefined;
                continue;
            }
            expectedChannelId = undefined;

            const friendChannel = VoiceStateStore.getVoiceStateForUser(followed)?.channelId ?? null;
            if (newChannel === friendChannel) continue;

            if (!newChannel) {
                paused = true;
                if (friendChannel) showToast(`You left voice - still following ${followedName()}, you'll join when they switch channels.`, "message");
                continue;
            }

            // Moved away (bot, admin or by hand) → back to the friend, unless something keeps moving us
            const now = Date.now();
            resyncs = resyncs.filter(t => now - t < RESYNC_WINDOW);
            if (resyncs.length >= MAX_RESYNCS) {
                paused = true;
                showToast(`You keep getting moved - waiting until ${followedName()} switches channels.`, "message");
                continue;
            }
            resyncs.push(now);
            scheduleSync(FOLLOW_DELAY * 2);
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

    renderTitleBarButton: titleBarSlot("FriendDock", renderTitleBarButton),

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
        resetFollowState();
        settings.store.following = null;
    }
});
