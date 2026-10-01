/*
 * ServerTools – ChannelHealth: analyze the activity of all readable text channels of a server
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { ChannelStore, GuildChannelStore, GuildStore, PermissionsBits, PermissionStore, SnowflakeUtils } from "@webpack/common";

import { loadHistory } from "./history";
import { CancelToken, describeError, isCancelled } from "./queue";

export interface ChannelStat {
    id: string;
    name: string;
    category: string | null;
    messages: number;
    authors: number;
    /** Last message ever (ms) or null */
    lastMessage: number | null;
    truncated: boolean;
    error?: string;
}

export interface MemberStat {
    id: string;
    name: string;
    count: number;
}

export interface HealthResult {
    guildId: string;
    guildName: string;
    days: number;
    maxPerChannel: number;
    scannedAt: number;
    channels: ChannelStat[];
    /** 7 x 24, index = weekday (Mon = 0) x 24 + hour, local time */
    heatmap: number[];
    topMembers: MemberStat[];
    totalMessages: number;
    uniqueAuthors: number;
    requests: number;
}

export interface ScanProgress {
    channelIndex: number;
    channelCount: number;
    channelName: string;
    loaded: number;
    totalMessages: number;
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ---------------------------------------------------------------- Channels

/** All text and announcement channels I can read (including history) */
export function getScanChannels(guildId: string) {
    const selectable = (GuildChannelStore.getChannels(guildId)?.SELECTABLE ?? []) as any[];
    return selectable
        .map(item => item.channel)
        .filter((c: any) => c && (c.type === 0 || c.type === 5))
        .filter((c: any) =>
            PermissionStore.can(PermissionsBits.VIEW_CHANNEL, c) &&
            PermissionStore.can(PermissionsBits.READ_MESSAGE_HISTORY, c)
        );
}

const lastMessageOf = (c: any): number | null => {
    const id = c.lastMessageId ?? c.last_message_id;
    if (!id) return null;
    try {
        return SnowflakeUtils.extractTimestamp(id);
    } catch {
        return null;
    }
};

// ---------------------------------------------------------------- Scan

export async function scanGuild(guildId: string, options: {
    days: number;
    maxPerChannel: number;
    token: CancelToken;
    onProgress(p: ScanProgress): void;
    onRateLimit?(seconds: number): void;
}): Promise<HealthResult> {
    const { days, maxPerChannel, token } = options;
    const since = Date.now() - days * 86400_000;
    const channels = getScanChannels(guildId);

    const heatmap = new Array(7 * 24).fill(0);
    const members = new Map<string, MemberStat>();
    const allAuthors = new Set<string>();
    const stats: ChannelStat[] = [];
    let totalMessages = 0;
    let requests = 0;

    for (let i = 0; i < channels.length; i++) {
        token.throwIfCancelled();
        const c = channels[i];
        const category = c.parent_id ? ChannelStore.getChannel(c.parent_id)?.name ?? null : null;
        const lastMessage = lastMessageOf(c);
        const stat: ChannelStat = { id: c.id, name: c.name, category, messages: 0, authors: 0, lastMessage, truncated: false };
        stats.push(stat);

        options.onProgress({ channelIndex: i, channelCount: channels.length, channelName: c.name, loaded: 0, totalMessages });

        // Last message older than the time range -> no request needed
        if (lastMessage != null && lastMessage < since) continue;

        try {
            const res = await loadHistory(c.id, {
                since,
                max: maxPerChannel,
                token,
                onRateLimit: options.onRateLimit,
                onProgress: loaded => options.onProgress({ channelIndex: i, channelCount: channels.length, channelName: c.name, loaded, totalMessages: totalMessages + loaded })
            });
            requests += res.requests;

            const authors = new Set<string>();
            for (const m of res.messages) {
                authors.add(m.authorId);
                allAuthors.add(m.authorId);
                const d = new Date(m.timestamp);
                heatmap[((d.getDay() + 6) % 7) * 24 + d.getHours()]++;
                if (!m.bot) {
                    const entry = members.get(m.authorId) ?? { id: m.authorId, name: m.authorName, count: 0 };
                    entry.count++;
                    members.set(m.authorId, entry);
                }
            }
            stat.messages = res.messages.length;
            stat.authors = authors.size;
            stat.truncated = res.truncated;
            if (res.messages[0]) stat.lastMessage = Math.max(stat.lastMessage ?? 0, res.messages[0].timestamp);
            totalMessages += res.messages.length;
        } catch (e) {
            if (isCancelled(e)) throw e;
            stat.error = describeError(e);
        }
    }

    stats.sort((a, b) => b.messages - a.messages || (b.lastMessage ?? 0) - (a.lastMessage ?? 0));

    return {
        guildId,
        guildName: GuildStore.getGuild(guildId)?.name ?? guildId,
        days,
        maxPerChannel,
        scannedAt: Date.now(),
        channels: stats,
        heatmap,
        topMembers: [...members.values()].sort((a, b) => b.count - a.count).slice(0, 10),
        totalMessages,
        uniqueAuthors: allAuthors.size,
        requests
    };
}

// ---------------------------------------------------------------- Suggestions

export interface Suggestion {
    channelId: string;
    kind: "dead" | "quiet" | "solo" | "capped";
    text: string;
}

export function buildSuggestions(result: HealthResult): Suggestion[] {
    const out: Suggestion[] = [];
    // "Quiet": fewer than ~2 messages per week
    const quietLimit = Math.max(3, Math.round(result.days / 7 * 2));
    const byCategory = new Map<string | null, ChannelStat[]>();
    for (const c of result.channels) {
        const list = byCategory.get(c.category) ?? [];
        list.push(c);
        byCategory.set(c.category, list);
    }

    for (const c of result.channels) {
        if (c.error) continue;
        if (c.messages === 0) {
            out.push({ channelId: c.id, kind: "dead", text: `#${c.name}: no messages in ${result.days} days - archive or delete?` });
        } else if (c.messages < quietLimit) {
            const sibling = (byCategory.get(c.category) ?? [])
                .filter(o => o.id !== c.id && o.messages >= quietLimit)
                .sort((a, b) => b.messages - a.messages)[0];
            out.push({
                channelId: c.id,
                kind: "quiet",
                text: `#${c.name}: barely active (${c.messages} messages) - merge${sibling ? `, e.g. with #${sibling.name}` : ""}?`
            });
        } else if (c.authors === 1) {
            out.push({ channelId: c.id, kind: "solo", text: `#${c.name}: only one person posts here - maybe an announcement/log channel?` });
        }
        if (c.truncated) out.push({ channelId: c.id, kind: "capped", text: `#${c.name}: limit of ${result.maxPerChannel} messages reached - numbers are minimums.` });
    }
    return out;
}

// ---------------------------------------------------------------- Cache

const cacheKey = (guildId: string) => `ServerTools_health_${guildId}`;

export async function loadCachedHealth(guildId: string): Promise<HealthResult | null> {
    try {
        return (await DataStore.get<HealthResult>(cacheKey(guildId))) ?? null;
    } catch {
        return null;
    }
}

export async function saveCachedHealth(result: HealthResult) {
    try {
        await DataStore.set(cacheKey(result.guildId), result);
    } catch { /* the cache is optional */ }
}

export async function clearCachedHealth(guildId: string) {
    await DataStore.del(cacheKey(guildId));
}

// ---------------------------------------------------------------- CSV

const csvCell = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV with semicolons (Excel in German locales opens it correctly right away), UTF-8 with BOM */
export function toCsv(result: HealthResult) {
    const rows: (string | number | null)[][] = [
        ["Channel", "Category", "Messages", "Authors", "Last message", "Status", "Limit reached", "Error"]
    ];
    for (const c of result.channels) {
        rows.push([
            c.name,
            c.category,
            c.messages,
            c.authors,
            c.lastMessage ? new Date(c.lastMessage).toISOString() : "",
            c.messages === 0 && !c.error ? "dead" : "active",
            c.truncated ? "yes" : "no",
            c.error ?? ""
        ]);
    }
    rows.push([]);
    rows.push(["Top members", "ID", "Messages"]);
    for (const m of result.topMembers) rows.push([m.name, m.id, m.count]);
    rows.push([]);
    rows.push(["Heatmap (local time)", ...Array.from({ length: 24 }, (_, h) => `${h}h`)]);
    WEEKDAYS.forEach((day, d) => rows.push([day, ...result.heatmap.slice(d * 24, d * 24 + 24)]));

    return "﻿" + rows.map(r => r.map(csvCell).join(";")).join("\r\n");
}
