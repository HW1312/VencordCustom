/*
 * FormatHub – Formats, templates & decoder (pure logic, no UI)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, Message } from "@vencord/discord-types";
import { ApplicationCommandIndexStore, ChannelStore, EmojiStore, GuildMemberStore, GuildRoleStore, GuildScheduledEventStore, GuildStore, MessageStore, UserStore } from "@webpack/common";

// ---------------------------------------------------------------- Basics

/** A ready-made format: display name + syntax that gets copied/inserted */
export interface FormatEntry {
    label: string;
    syntax: string;
    hint?: string;
    /** Render preview as a block (headings, lists, code blocks …) */
    block?: boolean;
}

export const DISCORD_EPOCH = 1420070400000n;
export const DISCORD_ORIGIN = "https://discord.com";

/** Checks whether a string is a plausible Discord ID (snowflake) */
export function isSnowflake(id: string | null | undefined): id is string {
    if (!id || !/^\d{17,20}$/.test(id)) return false;
    try {
        const ms = Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
        return ms > 1420070400000 && ms < Date.now() + 86_400_000;
    } catch {
        return false;
    }
}

export function snowflakeToDate(id: string): Date | null {
    if (!isSnowflake(id)) return null;
    return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

export function formatDate(date: Date) {
    return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

// ---------------------------------------------------------------- Links

export const messageLink = (guildId: string | null | undefined, channelId: string, messageId: string) =>
    `${DISCORD_ORIGIN}/channels/${guildId || "@me"}/${channelId}/${messageId}`;

export const channelLink = (guildId: string | null | undefined, channelId: string) =>
    `${DISCORD_ORIGIN}/channels/${guildId || "@me"}/${channelId}`;

export const guildLink = (guildId: string) => `${DISCORD_ORIGIN}/channels/${guildId}`;
export const eventLink = (guildId: string, eventId: string) => `${DISCORD_ORIGIN}/events/${guildId}/${eventId}`;
export const userLink = (userId: string) => `${DISCORD_ORIGIN}/users/${userId}`;
export const inviteLink = (code: string) => `https://discord.gg/${code}`;

export function emojiCdnUrl(id: string, animated: boolean, size = 96) {
    return `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}?size=${size}${animated ? "" : "&quality=lossless"}`;
}

export const emojiSyntax = (name: string, id: string, animated: boolean) => `<${animated ? "a" : ""}:${name}:${id}>`;

// ---------------------------------------------------------------- Timestamps

export const TIMESTAMP_FLAGS: { flag: string; label: string; }[] = [
    { flag: "", label: "Default (no flag)" },
    { flag: "t", label: "Short time" },
    { flag: "T", label: "Long time" },
    { flag: "d", label: "Short date" },
    { flag: "D", label: "Long date" },
    { flag: "f", label: "Date & time" },
    { flag: "F", label: "Weekday, date & time" },
    { flag: "R", label: "Relative" },
    { flag: "s", label: "Short date & time (new)" },
    { flag: "S", label: "Short date & long time (new)" }
];

export const timestampSyntax = (unix: number, flag: string) => `<t:${unix}${flag ? `:${flag}` : ""}>`;

// ---------------------------------------------------------------- Names

export function userDisplayName(userId: string, guildId?: string | null) {
    const user = UserStore.getUser(userId);
    if (!user) return null;
    const nick = guildId ? GuildMemberStore.getNick(guildId, userId) : null;
    return nick || user.globalName || user.username;
}

export function channelDisplayName(channel: Channel) {
    if (channel.name) return channel.name;
    const recipient = channel.recipients?.[0];
    return (recipient && userDisplayName(recipient)) || "Direct Message";
}

/** Looks up a role – first on the current server, then on all others */
export function findRole(roleId: string, preferGuildId?: string | null) {
    if (preferGuildId) {
        const role = GuildRoleStore.getRole(preferGuildId, roleId);
        if (role) return { role, guildId: preferGuildId };
    }
    for (const guild of GuildStore.getGuildsArray()) {
        const role = GuildRoleStore.getRole(guild.id, roleId);
        if (role) return { role, guildId: guild.id };
    }
    return null;
}

// ---------------------------------------------------------------- Slash commands

export interface SlashCommandInfo {
    id: string;
    /** Full name incl. group/subcommand, e.g. "config set" */
    name: string;
    description: string;
    app: string;
}

/** Reads the slash commands (command index) Discord has already loaded for a channel */
export function getSlashCommands(channel: Channel | null | undefined): SlashCommandInfo[] {
    const states: any[] = [];
    try {
        if (channel) states.push(ApplicationCommandIndexStore.getContextState({ type: "channel", channel }));
        const guildId = channel?.getGuildId?.();
        if (guildId) states.push(ApplicationCommandIndexStore.getGuildState(guildId));
        states.push(ApplicationCommandIndexStore.getUserState());
    } catch {
        // Store is structured differently in this Discord version – fall back to manual entry
    }

    const result = new Map<string, SlashCommandInfo>();
    for (const state of states) {
        const sections = state?.result?.sections;
        if (!sections) continue;
        for (const section of Object.values<any>(sections)) {
            for (const cmd of Object.values<any>(section?.commands ?? {})) {
                if (cmd?.type != null && cmd.type !== 1) continue; // chat commands only
                const root = cmd.rootCommand;
                const id: string = root?.id ?? String(cmd.id ?? "").split(/\D/)[0];
                if (!isSnowflake(id)) continue;
                const name: string = root && cmd.subCommandPath?.length
                    ? [root.name, ...cmd.subCommandPath.map((o: any) => o.name)].join(" ")
                    : cmd.untranslatedName ?? cmd.displayName ?? root?.name;
                if (!name) continue;
                result.set(`${id}:${name}`, {
                    id,
                    name,
                    description: cmd.untranslatedDescription ?? cmd.displayDescription ?? "",
                    app: section?.descriptor?.name ?? ""
                });
            }
        }
    }
    return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- Decoder

export type TokenStatus = "ok" | "warn" | "bad";

export interface DecodedToken {
    raw: string;
    index: number;
    kind: string;
    title: string;
    detail?: string;
    status: TokenStatus;
    /** User ID that can be fetched on click */
    fetchUserId?: string;
}

const NAV_LABELS: Record<string, string> = {
    customize: "Channels & Roles",
    browse: "Browse channels",
    guide: "Server guide",
    "linked-roles": "Linked roles"
};

const TOKEN_PATTERNS: { kind: string; regex: RegExp; decode(m: RegExpExecArray, guildId?: string | null): Omit<DecodedToken, "raw" | "index" | "kind">; }[] = [
    {
        kind: "Role",
        regex: /<@&(\d+)>/g,
        decode([, id], guildId) {
            if (!isSnowflake(id)) return { title: `Invalid role ID ${id}`, status: "bad" };
            const found = findRole(id, guildId);
            if (!found) return { title: `Unknown role (${id})`, detail: "Not found on any of your servers", status: "bad" };
            const guild = GuildStore.getGuild(found.guildId);
            return { title: `@${found.role.name}`, detail: `Role on ${guild?.name ?? "unknown server"}`, status: "ok" };
        }
    },
    {
        kind: "User",
        regex: /<@!?(\d+)>/g,
        decode([, id], guildId) {
            if (!isSnowflake(id)) return { title: `Invalid user ID ${id}`, status: "bad" };
            const user = UserStore.getUser(id);
            if (!user) return { title: `Unknown user (${id})`, detail: "Not in cache – can be fetched", status: "bad", fetchUserId: id };
            const name = userDisplayName(id, guildId);
            return { title: `@${name}`, detail: `User ${user.username}${user.bot ? " (Bot)" : ""}`, status: "ok" };
        }
    },
    {
        kind: "Channel",
        regex: /<#(\d+)>/g,
        decode([, id]) {
            if (!isSnowflake(id)) return { title: `Invalid channel ID ${id}`, status: "bad" };
            const channel = ChannelStore.getChannel(id);
            if (!channel) return { title: `Unknown channel (${id})`, detail: "No access or not in cache", status: "bad" };
            const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : null;
            return { title: `#${channelDisplayName(channel)}`, detail: guild ? `Channel on ${guild.name}` : "Direct message / group", status: "ok" };
        }
    },
    {
        kind: "Emoji",
        regex: /<(a?):(\w{2,32}):(\d+)>/g,
        decode([, animated, name, id]) {
            if (!isSnowflake(id)) return { title: `Invalid emoji ID ${id}`, status: "bad" };
            const emoji = EmojiStore.getCustomEmojiById(id);
            const kind = animated ? "Animated emoji" : "Emoji";
            if (!emoji) return { title: `:${name}:`, detail: `${kind} from another server`, status: "warn" };
            const guild = (emoji as any).guildId ? GuildStore.getGuild((emoji as any).guildId) : null;
            return { title: `:${emoji.name}:`, detail: `${kind}${guild ? ` from ${guild.name}` : ""}`, status: "ok" };
        }
    },
    {
        kind: "Timestamp",
        regex: /<t:(-?\d{1,13})(?::([tTdDfFRsS]))?>/g,
        decode([, unix, flag]) {
            const date = new Date(Number(unix) * 1000);
            if (isNaN(date.getTime())) return { title: "Invalid timestamp", status: "bad" };
            const label = TIMESTAMP_FLAGS.find(f => f.flag === (flag ?? ""))?.label ?? flag;
            return { title: formatDate(date), detail: `Format: ${label}`, status: "ok" };
        }
    },
    {
        kind: "Command",
        regex: /<\/([^:<>\n]{1,100}):(\d+)>/g,
        decode([, name, id]) {
            if (!isSnowflake(id)) return { title: `/${name}`, detail: `Invalid command ID ${id}`, status: "bad" };
            return { title: `/${name}`, detail: `Slash command, ID ${id}`, status: "ok" };
        }
    },
    {
        kind: "Server navigation",
        regex: /<id:(customize|browse|guide|linked-roles)(?::(\d+))?>/g,
        decode([, type, roleId]) {
            const label = NAV_LABELS[type] ?? type;
            if (!roleId) return { title: label, detail: "Jumps there on the current server", status: "ok" };
            const found = findRole(roleId);
            return found
                ? { title: `${label}: @${found.role.name}`, detail: "Linked role", status: "ok" }
                : { title: `${label}: unknown role`, detail: roleId, status: isSnowflake(roleId) ? "warn" : "bad" };
        }
    },
    {
        kind: "Mass mention",
        regex: /@(everyone|here)\b/g,
        decode([, what]) {
            return { title: `@${what}`, detail: what === "everyone" ? "All members with access" : "All online members with access", status: "ok" };
        }
    },
    {
        kind: "Message link",
        regex: /https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/g,
        decode([, guildId, channelId, messageId]) {
            if (!isSnowflake(channelId) || !isSnowflake(messageId)) return { title: "Invalid message link", status: "bad" };
            const channel = ChannelStore.getChannel(channelId);
            const guild = guildId !== "@me" ? GuildStore.getGuild(guildId) : null;
            const message: Message | undefined = MessageStore.getMessage(channelId, messageId);
            const where = channel ? `#${channelDisplayName(channel)}${guild ? ` on ${guild.name}` : ""}` : "unknown channel";
            const detail = message
                ? `${message.author?.username ?? "?"}: ${(message.content || "[no text]").slice(0, 80)}`
                : `Message from ${formatDate(snowflakeToDate(messageId)!)}`;
            return { title: `Message in ${where}`, detail, status: channel ? "ok" : "warn" };
        }
    },
    {
        kind: "Channel link",
        regex: /https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)(?![\d/])/g,
        decode([, guildId, channelId]) {
            if (!isSnowflake(channelId)) return { title: "Invalid channel link", status: "bad" };
            const channel = ChannelStore.getChannel(channelId);
            const guild = guildId !== "@me" ? GuildStore.getGuild(guildId) : null;
            if (!channel) return { title: "Unknown channel", detail: guild ? `On ${guild.name}` : channelId, status: "bad" };
            return { title: `#${channelDisplayName(channel)}`, detail: guild ? `Channel on ${guild.name}` : "Direct message / group", status: "ok" };
        }
    },
    {
        kind: "Event link",
        regex: /https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/events\/(\d+)\/(\d+)/g,
        decode([, guildId, eventId]) {
            if (!isSnowflake(guildId) || !isSnowflake(eventId)) return { title: "Invalid event link", status: "bad" };
            const event = GuildScheduledEventStore.getGuildScheduledEvent(eventId);
            const guild = GuildStore.getGuild(guildId);
            if (!event) return { title: "Unknown event", detail: guild ? `On ${guild.name}` : "Unknown server", status: "warn" };
            return { title: event.name, detail: `Event on ${guild?.name ?? "?"} · ${formatDate(new Date(event.scheduled_start_time))}`, status: "ok" };
        }
    },
    {
        kind: "Invite",
        regex: /(?:https?:\/\/)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]{2,32})/g,
        decode([, code]) {
            return { title: `Invite ${code}`, detail: "Invite link (not fetched automatically)", status: "ok" };
        }
    },
    {
        kind: "Profile link",
        regex: /https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/users\/(\d+)/g,
        decode([, id]) {
            if (!isSnowflake(id)) return { title: "Invalid profile link", status: "bad" };
            const user = UserStore.getUser(id);
            return user
                ? { title: `@${user.globalName || user.username}`, detail: `Profile of ${user.username}`, status: "ok" }
                : { title: `Unknown user (${id})`, detail: "Not in cache – can be fetched", status: "bad", fetchUserId: id };
        }
    },
    {
        kind: "Emoji URL",
        regex: /https?:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/emojis\/(\d+)(?:\.(\w+))?/g,
        decode([, id, ext]) {
            if (!isSnowflake(id)) return { title: "Invalid emoji URL", status: "bad" };
            const emoji = EmojiStore.getCustomEmojiById(id);
            return emoji
                ? { title: `:${emoji.name}:`, detail: `Emoji image (${ext ?? "?"})`, status: "ok" }
                : { title: `Emoji ${id}`, detail: "Emoji image from another server", status: "warn" };
        }
    }
];

/** Finds all Discord formats in the text and resolves them (in text order) */
export function decodeText(text: string, guildId?: string | null): DecodedToken[] {
    const tokens: DecodedToken[] = [];
    const taken: [number, number][] = [];
    const overlaps = (start: number, end: number) => taken.some(([s, e]) => start < e && end > s);

    for (const pattern of TOKEN_PATTERNS) {
        pattern.regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.regex.exec(text))) {
            const start = m.index, end = start + m[0].length;
            if (overlaps(start, end)) continue;
            taken.push([start, end]);
            let decoded: Omit<DecodedToken, "raw" | "index" | "kind">;
            try {
                decoded = pattern.decode(m, guildId);
            } catch {
                decoded = { title: "Could not be resolved", status: "bad" };
            }
            tokens.push({ raw: m[0], index: start, kind: pattern.kind, ...decoded });
        }
    }

    return tokens.sort((a, b) => a.index - b.index);
}

/** Latest messages of a channel from the cache (newest first) */
export function getRecentMessages(channelId: string, limit = 50): Message[] {
    const messages = MessageStore.getMessages(channelId) as any;
    const arr: Message[] = messages?._array ?? messages?.toArray?.() ?? [];
    return arr.slice(-limit).reverse();
}
