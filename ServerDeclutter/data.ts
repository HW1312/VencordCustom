/*
 * ServerDeclutter – build server overview from Discord's stores, filters & suggestions
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, GuildChannelStore, GuildMemberCountStore, GuildMemberStore, GuildReadStateStore, GuildStore, ReadStateStore, SortedGuildStore, UserGuildSettingsStore, UserStore } from "@webpack/common";

import { getActivity } from "./store";

const DAY = 86400_000;
const DISCORD_EPOCH = 1420070400000;

/** Timestamp from a snowflake ID (ms) */
export function snowflakeTime(id: string | null | undefined): number | null {
    if (!id || !/^\d{5,}$/.test(String(id))) return null;
    try {
        return Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------- Rows

export interface GuildRow {
    id: string;
    name: string;
    icon: string | null;
    memberCount: number | null;
    joinedAt: number | null;
    /** Last opened – tracked since installation */
    opened: number | null;
    /** Estimate from Discord's read state (newest read message) */
    readEstimate: number | null;
    /** Last written – tracked since installation */
    wrote: number | null;
    /** Newest message in a visible channel */
    lastActivity: number | null;
    muted: boolean;
    unreadChannels: number;
    mentions: number;
    folderName: string | null;
    owner: boolean;
}

/** Newest read / existing message per server from the read state data */
function collectReadStates() {
    const ack = new Map<string, number>();
    const last = new Map<string, number>();
    let states: any[] = [];
    try {
        states = ReadStateStore.getAllReadStates(false) ?? [];
    } catch { /* older Discord version */ }

    for (const s of states) {
        const guildId = s?._guildId ?? (s?.channelId ? ChannelStore.getChannel(s.channelId)?.guild_id : null);
        if (!guildId) continue;
        // Only regular channel read states (type 0), no events/notifications
        if (s.type != null && s.type !== 0) continue;
        const a = snowflakeTime(s._ackMessageId);
        if (a && a > (ack.get(guildId) ?? 0)) ack.set(guildId, a);
        const l = snowflakeTime(s._lastMessageId);
        if (l && l > (last.get(guildId) ?? 0)) last.set(guildId, l);
    }
    return { ack, last };
}

function folderMap() {
    const map = new Map<string, string>();
    try {
        for (const f of SortedGuildStore.getGuildFolders() ?? []) {
            if (f.folderId == null) continue;
            const name = f.folderName?.trim() || "Unnamed folder";
            for (const id of f.guildIds ?? []) map.set(String(id), name);
        }
    } catch { /* ignore */ }
    return map;
}

function joinedAtOf(guild: any): number | null {
    try {
        const d = GuildMemberStore.getSelfMemberJoinedAt?.(guild.id);
        if (d) return new Date(d).getTime();
    } catch { /* ignore */ }
    const own = GuildMemberStore.getSelfMember?.(guild.id)?.joinedAt;
    if (own) return new Date(own).getTime();
    if (guild.joinedAt) return new Date(guild.joinedAt).getTime() || null;
    return null;
}

export function buildRows(): GuildRow[] {
    const me = UserStore.getCurrentUser()?.id;
    const activity = getActivity().guilds;
    const { ack, last } = collectReadStates();
    const folders = folderMap();

    return Object.values(GuildStore.getGuilds()).map((guild: any) => {
        const id = guild.id as string;
        let unreadChannels = 0;
        let newest = last.get(id) ?? 0;

        const channels = GuildChannelStore.getChannels(id);
        const list: any[] = [...(channels?.SELECTABLE ?? []), ...(channels?.VOCAL ?? [])];
        for (const { channel } of list) {
            if (!channel) continue;
            const t = snowflakeTime(channel.lastMessageId);
            if (t && t > newest) newest = t;
            try {
                if (ReadStateStore.hasUnread(channel.id)) unreadChannels++;
            } catch { /* ignore */ }
        }

        let mentions = 0;
        try { mentions = GuildReadStateStore.getMentionCount(id) ?? 0; } catch { /* ignore */ }

        const a = activity[id] ?? {};
        return {
            id,
            name: guild.name ?? id,
            icon: guild.icon ?? null,
            memberCount: GuildMemberCountStore.getMemberCount(id) ?? null,
            joinedAt: joinedAtOf(guild),
            opened: a.opened ?? null,
            readEstimate: ack.get(id) ?? null,
            wrote: a.wrote ?? null,
            lastActivity: newest || null,
            muted: !!UserGuildSettingsStore.isMuted(id),
            unreadChannels,
            mentions,
            folderName: folders.get(id) ?? null,
            owner: !!me && guild.ownerId === me
        };
    });
}

// ---------------------------------------------------------------- Filters

export type FilterId = "all" | "neverOpened" | "stale" | "muted" | "dead" | "unread" | "mentions";

export interface Thresholds {
    staleDays: number;
    deadDays: number;
}

/** Best indication of when you last looked at the server */
export function lastSeen(r: GuildRow) {
    return Math.max(r.opened ?? 0, r.readEstimate ?? 0, r.joinedAt ?? 0) || null;
}

export function matchesFilter(r: GuildRow, filter: FilterId, t: Thresholds, now = Date.now()) {
    switch (filter) {
        case "all": return true;
        case "neverOpened": return r.opened == null;
        case "stale": return (lastSeen(r) ?? 0) < now - t.staleDays * DAY;
        case "muted": return r.muted;
        case "dead": return (r.lastActivity ?? 0) < now - t.deadDays * DAY;
        case "unread": return r.unreadChannels > 0;
        case "mentions": return r.mentions > 0;
    }
}

export function filterLabel(filter: FilterId, t: Thresholds) {
    switch (filter) {
        case "all": return "All";
        case "neverOpened": return "Never opened since tracking";
        case "stale": return `Not opened for ${t.staleDays} days`;
        case "muted": return "Muted";
        case "dead": return `Dead (no messages for ${t.deadDays} days)`;
        case "unread": return "Unread > 0";
        case "mentions": return "With @mentions";
    }
}

export const FILTERS: FilterId[] = ["all", "neverOpened", "stale", "muted", "dead", "unread", "mentions"];

// ---------------------------------------------------------------- Suggestions

export interface Suggestion {
    filter: FilterId;
    count: number;
    text: string;
    tone: "info" | "warn" | "danger";
}

export function buildSuggestions(rows: GuildRow[], t: Thresholds, trackingSince: number): Suggestion[] {
    const now = Date.now();
    const count = (f: FilterId) => rows.filter(r => matchesFilter(r, f, t, now)).length;
    const trackedDays = Math.floor((now - trackingSince) / DAY);
    const out: Suggestion[] = [];

    const stale = count("stale");
    if (stale) out.push({
        filter: "stale",
        count: stale,
        tone: "warn",
        text: `${stale} ${stale === 1 ? "server" : "servers"} not opened for ${t.staleDays} days${trackedDays < t.staleDays ? " (estimated)" : ""}`
    });

    const dead = count("dead");
    if (dead) out.push({ filter: "dead", count: dead, tone: "danger", text: `${dead} ${dead === 1 ? "server" : "servers"} without activity for ${t.deadDays} days` });

    const mentions = count("mentions");
    if (mentions) out.push({ filter: "mentions", count: mentions, tone: "info", text: `${mentions} ${mentions === 1 ? "server" : "servers"} with unread @mentions` });

    const never = count("neverOpened");
    if (never && trackedDays >= 1) out.push({
        filter: "neverOpened",
        count: never,
        tone: "info",
        text: `${never} ${never === 1 ? "server" : "servers"} never opened since tracking began (${trackedDays} ${trackedDays === 1 ? "day" : "days"} ago)`
    });

    const unreadMuted = rows.filter(r => r.muted && r.unreadChannels > 0).length;
    const unread = count("unread");
    if (unread) out.push({
        filter: "unread",
        count: unread,
        tone: "info",
        text: `${unread} ${unread === 1 ? "server" : "servers"} with unread messages${unreadMuted ? ` (${unreadMuted} muted)` : ""}`
    });

    return out;
}

// ---------------------------------------------------------------- Sorting

export type SortKey = "name" | "members" | "joined" | "opened" | "wrote" | "activity" | "muted" | "unread" | "folder";

export function sortValue(r: GuildRow, key: SortKey): string | number | null {
    switch (key) {
        case "name": return r.name.toLowerCase();
        case "members": return r.memberCount;
        case "joined": return r.joinedAt;
        case "opened": return r.opened ?? (r.readEstimate != null ? r.readEstimate - 1 : null);
        case "wrote": return r.wrote;
        case "activity": return r.lastActivity;
        case "muted": return r.muted ? 1 : 0;
        case "unread": return r.mentions * 10000 + r.unreadChannels;
        case "folder": return r.folderName?.toLowerCase() ?? null;
    }
}

export function sortRows(rows: GuildRow[], key: SortKey, dir: 1 | -1) {
    return [...rows].sort((a, b) => {
        const va = sortValue(a, key);
        const vb = sortValue(b, key);
        // Missing values always go last
        if (va == null && vb == null) return a.name.localeCompare(b.name);
        if (va == null) return 1;
        if (vb == null) return -1;
        const c = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
        return c * dir || a.name.localeCompare(b.name);
    });
}

// ---------------------------------------------------------------- Formatting

export function formatDate(ms: number | null) {
    return ms ? new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" }) : "–";
}

export function relative(ms: number | null) {
    if (!ms) return "–";
    const days = Math.floor((Date.now() - ms) / DAY);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 60) return `${days} days ago`;
    const months = Math.round(days / 30);
    if (months < 24) return `${months} months ago`;
    return `${Math.round(days / 365)} years ago`;
}
