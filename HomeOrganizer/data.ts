/*
 * HomeOrganizer – data: categorize DMs, score friend requests, actions (throttled)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled, plugins } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import {
    ChannelStore, Constants, IconUtils, NavigationRouter, PrivateChannelSortStore, ReadStateStore,
    RelationshipStore, SelectedChannelStore, SnowflakeUtils, UserProfileStore, UserStore
} from "@webpack/common";

import { settings } from "./index";
import { api, CancelToken, INTERVAL, isCancelled } from "./queue";

export const logger = new Logger("HomeOrganizer");

const DAY = 86400_000;

// ---------------------------------------------------------------- Helpers

export function snowflakeTime(id: string | null | undefined): number | null {
    if (!id) return null;
    try {
        return SnowflakeUtils.extractTimestamp(id);
    } catch {
        return null;
    }
}

export const daysSince = (ms: number) => Math.floor((Date.now() - ms) / DAY);

export function formatDate(ms: number | null | undefined) {
    return ms ? new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" }) : "–";
}

export function relative(ms: number | null | undefined) {
    if (!ms) return "never";
    const days = daysSince(ms);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 60) return `${days} days ago`;
    const months = Math.round(days / 30.4);
    if (months < 24) return `${months} months ago`;
    return `${Math.floor(days / 365)} years ago`;
}

export function userName(user: any, id?: string) {
    if (!user) return id ? `Unknown (${id})` : "Unknown";
    return RelationshipStore.getNickname(user.id) || user.globalName || user.username;
}

export function userAvatar(user: any, size = 40): string | undefined {
    try {
        return user?.getAvatarURL?.(undefined, size, false);
    } catch {
        return undefined;
    }
}

/**
 * The stock RelationshipNotifier plugin would otherwise report every removed request / left group as "was removed".
 * It tracks manual removals via its own methods - we call those right before sending.
 */
function markManualRemoval(kind: "removeFriend" | "removeGroup", id: string) {
    try {
        if (isPluginEnabled("RelationshipNotifier")) (plugins.RelationshipNotifier as any)?.[kind]?.(id);
    } catch { /* ignore */ }
}

// ---------------------------------------------------------------- Protection list & PinDMs

/** Channel IDs that are in PinDMs categories -> category name (only reads PinDMs' settings) */
export function getPinnedMap(): Map<string, string> {
    const map = new Map<string, string>();
    try {
        const myId = UserStore.getCurrentUser()?.id;
        const categories = (Settings.plugins as any).PinDMs?.userBasedCategoryList?.[myId ?? ""];
        if (!Array.isArray(categories)) return map;
        for (const cat of categories) {
            for (const id of cat?.channels ?? []) map.set(id, String(cat?.name ?? ""));
        }
    } catch (e) {
        logger.warn("Could not read PinDMs categories", e);
    }
    return map;
}

export function isProtectedId(channelId: string) {
    return settings.store.protectedIds.includes(channelId);
}

export function toggleProtected(channelId: string, value = !isProtectedId(channelId)) {
    const list = settings.store.protectedIds.filter(id => id !== channelId);
    if (value) list.push(channelId);
    settings.store.protectedIds = list;
}

// ---------------------------------------------------------------- DMs

export type DmGroup = "active" | "groups" | "quiet" | "asleep" | "never";

export const DM_GROUPS: { id: DmGroup; label: string; hint: string; }[] = [
    { id: "active", label: "Active", hint: "Last message within the active threshold" },
    { id: "groups", label: "Groups", hint: "Group DMs - closing means leaving here" },
    { id: "quiet", label: "Quiet", hint: "Between the active and quiet thresholds" },
    { id: "asleep", label: "Dormant", hint: "No messages for longer than the quiet threshold" },
    { id: "never", label: "Never messaged", hint: "No messages in the history at all" }
];

export interface DmEntry {
    id: string;
    isGroup: boolean;
    name: string;
    sub: string;
    avatar?: string;
    userId?: string;
    lastTs: number | null;
    group: DmGroup;
    mentions: number;
    unread: boolean;
    pinnedIn: string | null;
    protected: boolean;
}

function groupName(channel: any) {
    if (channel.name) return channel.name;
    const names = (channel.recipients ?? []).map((id: string) => userName(UserStore.getUser(id), id));
    return names.length ? names.join(", ") : "Unnamed group";
}

export function collectDms(): DmEntry[] {
    const { activeDays, quietDays, protectPinned } = settings.store;
    const pinned = getPinnedMap();
    const protectedSet = new Set(settings.store.protectedIds);
    const ids: string[] = PrivateChannelSortStore.getPrivateChannelIds?.() ?? Object.keys(ChannelStore.getMutablePrivateChannels());

    const out: DmEntry[] = [];
    for (const id of ids) {
        const channel: any = ChannelStore.getChannel(id);
        if (!channel) continue;
        const isGroup = channel.type === 3;
        if (channel.type !== 1 && !isGroup) continue;

        const lastTs = snowflakeTime(channel.lastMessageId);
        let group: DmGroup;
        if (isGroup) group = "groups";
        else if (lastTs == null) group = "never";
        else {
            const d = daysSince(lastTs);
            group = d <= activeDays ? "active" : d <= quietDays ? "quiet" : "asleep";
        }

        let name: string, sub: string, avatar: string | undefined, userId: string | undefined;
        if (isGroup) {
            name = groupName(channel);
            sub = `${(channel.recipients?.length ?? 0) + 1} members`;
            try {
                avatar = IconUtils.getChannelIconURL({ id: channel.id, icon: channel.icon, applicationId: channel.application_id, size: 40 });
            } catch { /* ignore */ }
        } else {
            userId = channel.getRecipientId?.() ?? channel.recipients?.[0];
            const user = userId ? UserStore.getUser(userId) : null;
            name = userName(user, userId);
            sub = user ? user.username : "";
            avatar = userAvatar(user);
        }

        const pinnedIn = pinned.get(id) ?? null;
        out.push({
            id,
            isGroup,
            name,
            sub,
            avatar,
            userId,
            lastTs,
            group,
            mentions: ReadStateStore.getMentionCount(id) ?? 0,
            unread: ReadStateStore.hasUnread(id) ?? false,
            pinnedIn,
            protected: protectedSet.has(id) || (protectPinned && pinnedIn != null)
        });
    }
    return out;
}

/** Closes a 1:1 DM (history is kept). Groups are deliberately rejected here. */
export async function closeDm(entry: DmEntry, token?: CancelToken, onRateLimit?: (s: number) => void) {
    if (entry.isGroup) throw new Error("Groups are not closed via bulk actions");
    if (entry.protected) throw new Error("Protected");
    await api("del", { url: `/channels/${entry.id}` }, {
        token,
        interval: INTERVAL.channel,
        onRateLimit,
        // Currently open DM: switch to the friends list first so no empty view is left behind
        before: () => SelectedChannelStore.getChannelId() === entry.id && NavigationRouter.transitionTo("/channels/@me")
    });
}

/** Leave group - only individually after a red confirmation */
export async function leaveGroup(channelId: string) {
    await api("del", { url: `/channels/${channelId}`, query: { silent: false } }, {
        interval: INTERVAL.channel,
        before: () => markManualRemoval("removeGroup", channelId)
    });
}

// ---------------------------------------------------------------- Friend requests

export interface MutualInfo {
    guilds: { id: string; nick?: string | null; }[];
    friends: number;
}

/** Session cache of mutuals (userId -> info | "error") */
export const mutualCache = new Map<string, MutualInfo | "error">();

export interface RequestEntry {
    id: string;
    user: any;
    name: string;
    username: string;
    avatar?: string;
    incoming: boolean;
    since: number | null;
    createdAt: number;
    ageDays: number;
    noAvatar: boolean;
    discordSpam: boolean;
    mutual: MutualInfo | "error" | null;
    score: number;
    reasons: { id: string; label: string; tone: "warn" | "bad" | "info"; }[];
}

function cachedMutual(id: string): MutualInfo | "error" | null {
    const own = mutualCache.get(id);
    if (own) return own;
    // Discord may have already loaded the profile (e.g. after hovering)
    try {
        const guilds = UserProfileStore.getMutualGuilds(id);
        const friends = UserProfileStore.getMutualFriendsCount(id);
        if (guilds && friends != null) return { guilds: guilds.map((g: any) => ({ id: g.guild?.id ?? g.id, nick: g.nick })), friends };
    } catch { /* ignore */ }
    return null;
}

export function buildRequest(id: string, incoming: boolean): RequestEntry {
    const user: any = UserStore.getUser(id);
    const createdAt = snowflakeTime(id) ?? Date.now();
    const ageDays = daysSince(createdAt);
    const sinceRaw = RelationshipStore.getSince(id);
    const since = sinceRaw ? Date.parse(sinceRaw) || null : null;
    const noAvatar = !user?.avatar;
    let discordSpam = false;
    try { discordSpam = !!RelationshipStore.isSpam(id); } catch { /* ignore */ }
    const mutual = cachedMutual(id);

    const reasons: RequestEntry["reasons"] = [];
    let score = 0;
    if (ageDays < settings.store.spamAccountDays) {
        score += ageDays < 7 ? 45 : 35;
        reasons.push({ id: "new", label: ageDays < 7 ? "Brand new account" : "New account", tone: "bad" });
    }
    if (noAvatar) {
        score += 20;
        reasons.push({ id: "avatar", label: "No avatar", tone: "warn" });
    }
    if (mutual && mutual !== "error" && mutual.guilds.length === 0 && mutual.friends === 0) {
        score += 30;
        reasons.push({ id: "mutual", label: "No mutuals", tone: "warn" });
    }
    if (discordSpam) {
        score += 40;
        reasons.push({ id: "spam", label: "Flagged as spam by Discord", tone: "bad" });
    }
    if (!user?.globalName && user) {
        score += 5;
        reasons.push({ id: "noname", label: "No display name", tone: "info" });
    }

    return {
        id,
        user,
        name: userName(user, id),
        username: user?.username ?? id,
        avatar: userAvatar(user),
        incoming,
        since,
        createdAt,
        ageDays,
        noAvatar,
        discordSpam,
        mutual,
        score: Math.min(100, score),
        reasons
    };
}

export function collectRequests(): RequestEntry[] {
    const out: RequestEntry[] = [];
    for (const [id, type] of RelationshipStore.getMutableRelationships()) {
        if (type === 3) out.push(buildRequest(id, true));
        else if (type === 4) out.push(buildRequest(id, false));
    }
    return out;
}

export const mutualTotal = (m: RequestEntry["mutual"]) => m && m !== "error" ? m.guilds.length + m.friends : -1;

/** Loads mutuals via the profile endpoint (throttled). */
export async function loadMutual(id: string, token?: CancelToken, onRateLimit?: (s: number) => void): Promise<MutualInfo | "error"> {
    try {
        const body = await api("get", {
            url: Constants.Endpoints.USER_PROFILE(id),
            query: { with_mutual_guilds: true, with_mutual_friends_count: true }
        }, { token, interval: INTERVAL.profile, onRateLimit });
        const info: MutualInfo = {
            guilds: (body?.mutual_guilds ?? []).map((g: any) => ({ id: g.id, nick: g.nick })),
            friends: Number(body?.mutual_friends_count ?? 0) || 0
        };
        mutualCache.set(id, info);
        return info;
    } catch (e) {
        if (isCancelled(e)) throw e;
        logger.warn("Could not load profile", id, e);
        mutualCache.set(id, "error");
        return "error";
    }
}

export async function acceptRequest(id: string, token?: CancelToken, onRateLimit?: (s: number) => void) {
    await api("put", { url: `/users/@me/relationships/${id}`, body: {} }, { token, interval: INTERVAL.relationship, onRateLimit });
}

/** Ignore/decline a request or withdraw your own request */
export async function removeRequest(id: string, token?: CancelToken, onRateLimit?: (s: number) => void) {
    await api("del", { url: `/users/@me/relationships/${id}` }, {
        token,
        interval: INTERVAL.relationship,
        onRateLimit,
        before: () => markManualRemoval("removeFriend", id)
    });
}
