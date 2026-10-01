/*
 * ServerTools – ServerBackup: export to a .zip and restore into a server of your own
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, EmojiStore, GuildRoleStore, GuildStore, StickersStore, UserStore } from "@webpack/common";
import { strFromU8, strToU8, unzipSync, Zippable,zipSync } from "fflate";

import { api, ApiError, CancelToken, describeError, fetchBinary, isCancelled } from "./queue";

// ---------------------------------------------------------------- Format

export const BACKUP_FORMAT = "ServerTools-Backup";
export const BACKUP_VERSION = 1;

export interface BackupOverwrite {
    id: string;
    /** 0 = role, 1 = member */
    type: number;
    allow: string;
    deny: string;
}

export interface BackupRole {
    id: string;
    name: string;
    color: number;
    hoist: boolean;
    mentionable: boolean;
    permissions: string;
    position: number;
    managed: boolean;
    everyone: boolean;
    unicode_emoji: string | null;
    /** Path in the zip */
    icon: string | null;
}

export interface BackupChannel {
    id: string;
    type: number;
    name: string;
    position: number;
    parent_id: string | null;
    topic: string | null;
    nsfw: boolean;
    rate_limit_per_user: number;
    bitrate: number | null;
    user_limit: number | null;
    rtc_region: string | null;
    video_quality_mode: number | null;
    permission_overwrites: BackupOverwrite[];
    available_tags: { name: string; moderated: boolean; emoji_id: string | null; emoji_name: string | null; }[] | null;
    default_reaction_emoji: { emoji_id: string | null; emoji_name: string | null; } | null;
    default_sort_order: number | null;
    default_forum_layout: number | null;
    default_thread_rate_limit_per_user: number | null;
}

export interface BackupEmoji {
    id: string;
    name: string;
    animated: boolean;
    roles: string[];
    file: string | null;
}

export interface BackupSticker {
    id: string;
    name: string;
    description: string;
    tags: string;
    format_type: number;
    file: string | null;
}

export interface BackupWebhook {
    name: string;
    channel_id: string;
    channel_name: string;
}

export interface BackupGuild {
    name: string;
    icon: string | null;
    banner: string | null;
    splash: string | null;
    verification_level: number;
    default_message_notifications: number;
    explicit_content_filter: number;
    system_channel_id: string | null;
    system_channel_flags: number;
    rules_channel_id: string | null;
    public_updates_channel_id: string | null;
    afk_channel_id: string | null;
    afk_timeout: number;
    preferred_locale: string;
    description: string | null;
    premium_progress_bar_enabled: boolean;
    features: string[];
}

export interface Backup {
    format: typeof BACKUP_FORMAT;
    version: number;
    createdAt: string;
    source: { id: string; name: string; };
    guild: BackupGuild;
    roles: BackupRole[];
    channels: BackupChannel[];
    emojis: BackupEmoji[];
    stickers: BackupSticker[];
    webhooks: BackupWebhook[];
    notes: string[];
}

export interface BackupBundle {
    backup: Backup;
    files: Record<string, Uint8Array>;
}

export type LogKind = "ok" | "info" | "warn" | "error";

export interface JobHooks {
    token: CancelToken;
    onProgress(done: number, total: number, label: string): void;
    log(kind: LogKind, text: string): void;
    onRateLimit?(seconds: number): void;
}

// ---------------------------------------------------------------- Helpers

const CDN = "https://cdn.discordapp.com";
const MEDIA = "https://media.discordapp.net";

const imgExt = (hash: string) => hash.startsWith("a_") ? "gif" : "png";

const safeName = (s: string) => (s || "file").replace(/[^\w-]+/g, "_").slice(0, 40);

const str = (v: any): string | null => v == null || v === "" ? null : String(v);
const num = (v: any): number | null => v == null ? null : Number(v);

function stickerUrl(id: string, format: number) {
    switch (format) {
        case 3: return `${CDN}/stickers/${id}.json`;
        case 4: return `${MEDIA}/stickers/${id}.gif`;
        default: return `${MEDIA}/stickers/${id}.png?size=320`;
    }
}

function stickerExt(format: number) {
    return format === 3 ? "json" : format === 4 ? "gif" : "png";
}

function mimeOf(path: string) {
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".json")) return "application/json";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    return "image/png";
}

async function toDataUri(bytes: Uint8Array, mime: string) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(new Blob([bytes as BlobPart], { type: mime }));
    });
}

function mapOverwrites(list: any[] | Record<string, any> | undefined): BackupOverwrite[] {
    const arr = Array.isArray(list) ? list : Object.values(list ?? {});
    return arr.map(o => ({
        id: String(o.id),
        type: Number(o.type),
        allow: String(o.allow ?? "0"),
        deny: String(o.deny ?? "0")
    }));
}

// ---------------------------------------------------------------- Export: collecting data

function guildFromStore(guildId: string) {
    const g: any = GuildStore.getGuild(guildId);
    if (!g) throw new Error("Server not found");
    const roles = Object.values(GuildRoleStore.getRolesSnapshot?.(guildId) ?? GuildRoleStore.getUnsafeMutableRoles(guildId) ?? {}).map((r: any) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        mentionable: r.mentionable,
        permissions: String(r.permissions),
        position: r.position,
        managed: r.managed,
        icon: r.icon ?? null,
        unicode_emoji: r.unicodeEmoji ?? null
    }));
    return {
        id: g.id,
        name: g.name,
        icon: g.icon ?? null,
        banner: g.banner ?? null,
        splash: g.splash ?? null,
        verification_level: g.verificationLevel,
        default_message_notifications: g.defaultMessageNotifications,
        explicit_content_filter: g.explicitContentFilter,
        system_channel_id: g.systemChannelId ?? null,
        system_channel_flags: g.systemChannelFlags ?? 0,
        rules_channel_id: g.rulesChannelId ?? null,
        public_updates_channel_id: g.publicUpdatesChannelId ?? null,
        afk_channel_id: g.afkChannelId ?? null,
        afk_timeout: g.afkTimeout,
        preferred_locale: g.preferredLocale,
        description: g.description ?? null,
        premium_progress_bar_enabled: !!g.premiumProgressBarEnabled,
        features: [...(g.features ?? [])],
        roles,
        emojis: EmojiStore.getGuildEmoji(guildId).map((e: any) => ({ id: e.id, name: e.name, animated: e.animated, roles: e.roles ?? [], managed: e.managed })),
        stickers: (StickersStore.getStickersByGuildId(guildId) ?? []).map((s: any) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags, format_type: s.format_type }))
    };
}

function channelsFromStore(guildId: string) {
    return Object.values(ChannelStore.getMutableGuildChannelsForGuild(guildId) ?? {}).map((c: any) => ({
        id: c.id,
        type: c.type,
        name: c.name,
        position: c.position,
        parent_id: c.parent_id ?? null,
        topic: c.topic,
        nsfw: c.nsfw,
        rate_limit_per_user: c.rateLimitPerUser,
        bitrate: c.bitrate,
        user_limit: c.userLimit,
        rtc_region: c.rtcRegion,
        video_quality_mode: c.videoQualityMode,
        permission_overwrites: Object.values(c.permissionOverwrites ?? {}),
        available_tags: c.availableTags,
        default_reaction_emoji: c.defaultReactionEmoji ? { emoji_id: c.defaultReactionEmoji.emojiId, emoji_name: c.defaultReactionEmoji.emojiName } : null,
        default_sort_order: c.defaultSortOrder,
        default_forum_layout: c.defaultForumLayout,
        default_thread_rate_limit_per_user: c.defaultThreadRateLimitPerUser
    }));
}

/** Reads all data of a server including images. API first (more complete), falls back to the stores on error. */
export async function collectBackup(guildId: string, hooks: JobHooks): Promise<BackupBundle> {
    const { token, log } = hooks;
    const notes: string[] = [];
    const files: Record<string, Uint8Array> = {};
    const opts = { token, onRateLimit: hooks.onRateLimit };

    hooks.onProgress(0, 1, "Loading server data …");

    let raw: any;
    try {
        raw = await api("get", { url: `/guilds/${guildId}` }, opts);
        log("ok", "Server settings, roles, emojis and stickers loaded");
    } catch (e) {
        if (isCancelled(e)) throw e;
        log("warn", `API unavailable (${describeError(e)}) - using local data`);
        raw = guildFromStore(guildId);
        notes.push("Server settings/roles read from the local cache");
    }

    let rawChannels: any[];
    try {
        rawChannels = await api<any[]>("get", { url: `/guilds/${guildId}/channels` }, opts);
        log("ok", `${rawChannels.length} channels loaded`);
    } catch (e) {
        if (isCancelled(e)) throw e;
        log("warn", `Channels from the local cache (${describeError(e)})`);
        rawChannels = channelsFromStore(guildId);
        notes.push("Channels read from the local cache");
    }
    rawChannels = rawChannels.filter(c => [0, 2, 4, 5, 13, 15, 16].includes(c.type));

    // Webhooks: name + channel only - tokens/URLs are NEVER stored
    let webhooks: BackupWebhook[] = [];
    try {
        const list = await api<any[]>("get", { url: `/guilds/${guildId}/webhooks` }, opts);
        webhooks = list.map(w => ({
            name: String(w.name ?? ""),
            channel_id: String(w.channel_id ?? ""),
            channel_name: rawChannels.find(c => c.id === w.channel_id)?.name ?? ""
        }));
        log("ok", `${webhooks.length} webhooks (name & channel only, no token/URL)`);
    } catch (e) {
        if (isCancelled(e)) throw e;
        log("info", `Webhooks skipped (${describeError(e)})`);
        notes.push("Webhooks not read (missing “Manage Webhooks” permission)");
    }

    const everyoneId = guildId;
    const roles: BackupRole[] = (raw.roles ?? []).map((r: any) => ({
        id: String(r.id),
        name: String(r.name),
        color: Number(r.color ?? 0),
        hoist: !!r.hoist,
        mentionable: !!r.mentionable,
        permissions: String(r.permissions ?? "0"),
        position: Number(r.position ?? 0),
        managed: !!r.managed,
        everyone: r.id === everyoneId,
        unicode_emoji: r.unicode_emoji ?? null,
        icon: r.icon ?? null
    })).sort((a: BackupRole, b: BackupRole) => a.position - b.position);

    const channels: BackupChannel[] = rawChannels.map(c => ({
        id: String(c.id),
        type: Number(c.type),
        name: String(c.name),
        position: Number(c.position ?? 0),
        parent_id: str(c.parent_id),
        topic: str(c.topic),
        nsfw: !!c.nsfw,
        rate_limit_per_user: Number(c.rate_limit_per_user ?? 0),
        bitrate: num(c.bitrate),
        user_limit: num(c.user_limit),
        rtc_region: str(c.rtc_region),
        video_quality_mode: num(c.video_quality_mode),
        permission_overwrites: mapOverwrites(c.permission_overwrites),
        available_tags: Array.isArray(c.available_tags)
            ? c.available_tags.map((t: any) => ({ name: t.name, moderated: !!t.moderated, emoji_id: str(t.emoji_id ?? t.emojiId), emoji_name: str(t.emoji_name ?? t.emojiName) }))
            : null,
        default_reaction_emoji: c.default_reaction_emoji ?? null,
        default_sort_order: num(c.default_sort_order),
        default_forum_layout: num(c.default_forum_layout),
        default_thread_rate_limit_per_user: num(c.default_thread_rate_limit_per_user)
    })).sort((a, b) => a.position - b.position);

    const emojiList: any[] = (raw.emojis ?? []).filter((e: any) => !e.managed);
    const stickerList: any[] = raw.stickers ?? [];

    // ---- Download images
    const downloads: { label: string; url: string; path: string; assign(path: string | null): void; }[] = [];
    const guildData: BackupGuild = {
        name: raw.name,
        icon: null,
        banner: null,
        splash: null,
        verification_level: Number(raw.verification_level ?? 0),
        default_message_notifications: Number(raw.default_message_notifications ?? 0),
        explicit_content_filter: Number(raw.explicit_content_filter ?? 0),
        system_channel_id: str(raw.system_channel_id),
        system_channel_flags: Number(raw.system_channel_flags ?? 0),
        rules_channel_id: str(raw.rules_channel_id),
        public_updates_channel_id: str(raw.public_updates_channel_id),
        afk_channel_id: str(raw.afk_channel_id),
        afk_timeout: Number(raw.afk_timeout ?? 300),
        preferred_locale: String(raw.preferred_locale ?? "de"),
        description: str(raw.description),
        premium_progress_bar_enabled: !!raw.premium_progress_bar_enabled,
        features: [...(raw.features ?? [])]
    };

    if (raw.icon) downloads.push({ label: "Server icon", url: `${CDN}/icons/${guildId}/${raw.icon}.${imgExt(raw.icon)}?size=1024`, path: `icon.${imgExt(raw.icon)}`, assign: p => guildData.icon = p });
    if (raw.banner) downloads.push({ label: "Banner", url: `${CDN}/banners/${guildId}/${raw.banner}.${imgExt(raw.banner)}?size=2048`, path: `banner.${imgExt(raw.banner)}`, assign: p => guildData.banner = p });
    if (raw.splash) downloads.push({ label: "Invite splash", url: `${CDN}/splashes/${guildId}/${raw.splash}.png?size=2048`, path: "splash.png", assign: p => guildData.splash = p });

    for (const role of roles) {
        const hash = role.icon;
        role.icon = null;
        if (hash) downloads.push({ label: `Role icon ${role.name}`, url: `${CDN}/role-icons/${role.id}/${hash}.png?size=256`, path: `roles/${safeName(role.name)}_${role.id}.png`, assign: p => role.icon = p });
    }

    const emojis: BackupEmoji[] = emojiList.map(e => {
        const entry: BackupEmoji = { id: String(e.id), name: String(e.name), animated: !!e.animated, roles: (e.roles ?? []).map(String), file: null };
        const ext = entry.animated ? "gif" : "png";
        downloads.push({ label: `Emoji :${entry.name}:`, url: `${CDN}/emojis/${entry.id}.${ext}`, path: `emojis/${safeName(entry.name)}_${entry.id}.${ext}`, assign: p => entry.file = p });
        return entry;
    });

    const stickers: BackupSticker[] = stickerList.map(s => {
        const entry: BackupSticker = { id: String(s.id), name: String(s.name), description: String(s.description ?? ""), tags: String(s.tags ?? ""), format_type: Number(s.format_type ?? 1), file: null };
        downloads.push({ label: `Sticker ${entry.name}`, url: stickerUrl(entry.id, entry.format_type), path: `stickers/${safeName(entry.name)}_${entry.id}.${stickerExt(entry.format_type)}`, assign: p => entry.file = p });
        return entry;
    });

    let failed = 0;
    for (let i = 0; i < downloads.length; i++) {
        const d = downloads[i];
        hooks.onProgress(i, downloads.length, `Downloading ${d.label} …`);
        const data = await fetchBinary(d.url, token);
        if (data) {
            files[d.path] = data;
            d.assign(d.path);
        } else {
            failed++;
            log("warn", `${d.label}: download failed`);
        }
    }
    hooks.onProgress(downloads.length, downloads.length, "Done");
    if (downloads.length) log(failed ? "warn" : "ok", `${downloads.length - failed}/${downloads.length} images downloaded`);
    if (failed) notes.push(`${failed} images could not be downloaded`);

    const managed = roles.filter(r => r.managed).length;
    if (managed) notes.push(`${managed} managed roles (bots/boosters) are saved but will be skipped on restore`);

    return {
        backup: {
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            createdAt: new Date().toISOString(),
            source: { id: guildId, name: raw.name },
            guild: guildData,
            roles,
            channels,
            emojis,
            stickers,
            webhooks,
            notes
        },
        files
    };
}

// ---------------------------------------------------------------- Zip

export function buildZip({ backup, files }: BackupBundle): Uint8Array {
    const entries: Zippable = {
        "backup.json": strToU8(JSON.stringify(backup, null, 2))
    };
    // Images are already compressed -> store only
    for (const [path, data] of Object.entries(files)) entries[path] = [data, { level: 0 }];
    return zipSync(entries, { level: 6 });
}

export function backupFileName(backup: Backup) {
    const date = backup.createdAt.slice(0, 10);
    return `backup-${safeName(backup.source.name)}-${date}.zip`;
}

export async function readBackupZip(file: File): Promise<BackupBundle> {
    const data = new Uint8Array(await file.arrayBuffer());
    let entries: Record<string, Uint8Array>;
    try {
        entries = unzipSync(data);
    } catch {
        throw new Error("File is not a valid zip archive");
    }

    const json = entries["backup.json"];
    if (!json) throw new Error("backup.json is missing from the archive");

    let backup: Backup;
    try {
        backup = JSON.parse(strFromU8(json));
    } catch {
        throw new Error("backup.json is corrupted");
    }
    if (backup?.format !== BACKUP_FORMAT) throw new Error("Not a ServerTools backup");
    if (backup.version > BACKUP_VERSION) throw new Error("Backup comes from a newer plugin version");

    for (const key of ["roles", "channels", "emojis", "stickers", "webhooks", "notes"] as const) {
        if (!Array.isArray(backup[key])) (backup as any)[key] = [];
    }

    delete entries["backup.json"];
    return { backup, files: entries };
}

export function summarize(backup: Backup) {
    const categories = backup.channels.filter(c => c.type === 4).length;
    return {
        roles: backup.roles.filter(r => !r.everyone).length,
        managedRoles: backup.roles.filter(r => r.managed).length,
        categories,
        channels: backup.channels.length - categories,
        emojis: backup.emojis.length,
        stickers: backup.stickers.length,
        webhooks: backup.webhooks.length
    };
}

// ---------------------------------------------------------------- Restore

export interface RestoreSections {
    settings: boolean;
    roles: boolean;
    channels: boolean;
    emojis: boolean;
    stickers: boolean;
}

export interface RestorePlan {
    bundle: BackupBundle;
    targetGuildId: string;
    sections: RestoreSections;
    deleteExisting: boolean;
}

/** Only servers I own */
export function getOwnedGuilds() {
    const me = UserStore.getCurrentUser()?.id;
    return Object.values(GuildStore.getGuilds())
        .filter(g => g.ownerId === me)
        .sort((a, b) => a.name.localeCompare(b.name));
}

const RESTORABLE_ROLE = (r: BackupRole) => !r.everyone && !r.managed;

/** Approximate number of requests (for progress & warning) */
export function estimateRequests(plan: Omit<RestorePlan, "targetGuildId"> & { targetGuildId?: string; }) {
    const { backup } = plan.bundle;
    const s = plan.sections;
    let n = 0;
    if (s.roles) n += backup.roles.filter(RESTORABLE_ROLE).length + 2;
    if (s.channels) n += backup.channels.length;
    if (s.emojis) n += backup.emojis.filter(e => e.file).length;
    if (s.stickers) n += backup.stickers.filter(st => st.file && st.format_type !== 3).length;
    if (s.settings) n += 1;
    if (plan.deleteExisting && plan.targetGuildId) {
        n += Object.keys(ChannelStore.getMutableGuildChannelsForGuild(plan.targetGuildId) ?? {}).length;
        n += Math.max(0, Object.keys(GuildRoleStore.getRolesSnapshot?.(plan.targetGuildId) ?? {}).length - 1);
    }
    return n;
}

const BITRATE_MAX = [96000, 128000, 256000, 384000];
/** Channel types that require Community -> replacement */
const TYPE_FALLBACK: Record<number, number> = { 5: 0, 13: 2, 15: 0, 16: 0 };

export async function runRestore(plan: RestorePlan, hooks: JobHooks) {
    const { backup, files } = plan.bundle;
    const { token, log } = hooks;
    const target = plan.targetGuildId;
    const sourceId = backup.source.id;
    const opts = { token, onRateLimit: hooks.onRateLimit };
    const targetGuild: any = GuildStore.getGuild(target);

    if (!targetGuild || targetGuild.ownerId !== UserStore.getCurrentUser()?.id)
        throw new Error("You are not the owner of the target server");

    let total = estimateRequests(plan);
    let done = 0;
    const step = (label: string) => hooks.onProgress(done++, total, label);

    const roleMap = new Map<string, string>([[sourceId, target]]);
    const channelMap = new Map<string, string>();
    const stats = { ok: 0, failed: 0 };

    const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
        step(label);
        try {
            const res = await fn();
            stats.ok++;
            return res;
        } catch (e) {
            if (isCancelled(e)) throw e;
            stats.failed++;
            log("error", `${label}: ${describeError(e)}`);
            return null;
        }
    };

    // ---- 1. Delete existing content (only if explicitly chosen)
    if (plan.deleteExisting) {
        log("info", "Deleting existing channels and roles …");
        const existingChannels = await api<any[]>("get", { url: `/guilds/${target}/channels` }, opts).catch(e => {
            if (isCancelled(e)) throw e;
            return Object.values(ChannelStore.getMutableGuildChannelsForGuild(target) ?? {});
        });
        // Channels first, then categories
        const ordered = [...existingChannels].sort((a: any, b: any) => (a.type === 4 ? 1 : 0) - (b.type === 4 ? 1 : 0));
        for (const ch of ordered) {
            await attempt(`Delete channel #${ch.name}`, () => api("del", { url: `/channels/${ch.id}` }, opts));
        }

        const existingRoles = await api<any[]>("get", { url: `/guilds/${target}/roles` }, opts).catch(e => {
            if (isCancelled(e)) throw e;
            return Object.values(GuildRoleStore.getRolesSnapshot?.(target) ?? {});
        });
        for (const role of existingRoles) {
            if (role.id === target || role.managed) continue;
            await attempt(`Delete role ${role.name}`, () => api("del", { url: `/guilds/${target}/roles/${role.id}` }, opts));
        }
    }

    // ---- 2. Roles (create from top to bottom, then set positions)
    if (plan.sections.roles) {
        const canIcons = targetGuild.features?.has?.("ROLE_ICONS");
        const roles = backup.roles.filter(RESTORABLE_ROLE).sort((a, b) => b.position - a.position);
        const skipped = backup.roles.filter(r => r.managed).length;
        if (skipped) log("info", `${skipped} managed roles (bots/boosters) skipped`);

        for (const role of roles) {
            const body: any = {
                name: role.name,
                permissions: role.permissions,
                color: role.color,
                hoist: role.hoist,
                mentionable: role.mentionable
            };
            if (canIcons) {
                if (role.unicode_emoji) body.unicode_emoji = role.unicode_emoji;
                else if (role.icon && files[role.icon]) body.icon = await toDataUri(files[role.icon], mimeOf(role.icon));
            }
            const created = await attempt(`Role ${role.name}`, () => api("post", { url: `/guilds/${target}/roles`, body }, opts));
            if (created?.id) roleMap.set(role.id, created.id);
        }

        // Same order as the original (bottom = position 1)
        const positions = [...roles].reverse()
            .filter(r => roleMap.has(r.id))
            .map((r, i) => ({ id: roleMap.get(r.id)!, position: i + 1 }));
        if (positions.length > 1) {
            await attempt("Role order", () => api("patch", { url: `/guilds/${target}/roles`, body: positions }, opts));
        } else done++;

        const everyone = backup.roles.find(r => r.everyone);
        if (everyone) {
            await attempt("@everyone permissions", () => api("patch", { url: `/guilds/${target}/roles/${target}`, body: { permissions: everyone.permissions } }, opts));
        } else done++;
        log("ok", `${roleMap.size - 1}/${roles.length} roles created`);
    }

    // ---- 3. Categories, then channels
    if (plan.sections.channels) {
        const maxBitrate = BITRATE_MAX[targetGuild.premiumTier ?? 0] ?? 96000;
        const warnedRoles = new Set<string>();

        const mapOverwrite = (o: BackupOverwrite) => {
            if (o.type === 1) return { ...o };
            const id = roleMap.get(o.id);
            if (!id) {
                if (!warnedRoles.has(o.id)) {
                    warnedRoles.add(o.id);
                    log("warn", `Permission for unrestored role ${backup.roles.find(r => r.id === o.id)?.name ?? o.id} skipped`);
                }
                return null;
            }
            return { ...o, id };
        };

        const buildBody = (c: BackupChannel, type: number, withMembers: boolean) => {
            const body: any = {
                name: c.name,
                type,
                position: c.position,
                permission_overwrites: c.permission_overwrites
                    .filter(o => withMembers || o.type !== 1)
                    .map(mapOverwrite)
                    .filter(Boolean)
            };
            if (c.parent_id && channelMap.has(c.parent_id)) body.parent_id = channelMap.get(c.parent_id);
            if ([0, 5, 15, 16].includes(type)) {
                if (c.topic) body.topic = c.topic;
                body.nsfw = c.nsfw;
                if (type !== 5) body.rate_limit_per_user = c.rate_limit_per_user;
            }
            if ([2, 13].includes(type)) {
                if (c.bitrate) body.bitrate = Math.min(c.bitrate, maxBitrate);
                if (c.user_limit != null) body.user_limit = c.user_limit;
                if (c.rtc_region) body.rtc_region = c.rtc_region;
                if (c.video_quality_mode != null && type === 2) body.video_quality_mode = c.video_quality_mode;
                if (type === 2) body.nsfw = c.nsfw;
            }
            if ([15, 16].includes(type)) {
                // Custom emojis don't exist in the new server yet -> only carry over Unicode emojis
                if (c.available_tags) body.available_tags = c.available_tags.map(t => ({ name: t.name, moderated: t.moderated, emoji_name: t.emoji_id ? null : t.emoji_name }));
                if (c.default_reaction_emoji?.emoji_name && !c.default_reaction_emoji.emoji_id) body.default_reaction_emoji = { emoji_name: c.default_reaction_emoji.emoji_name };
                if (c.default_sort_order != null) body.default_sort_order = c.default_sort_order;
                if (c.default_forum_layout != null && type === 15) body.default_forum_layout = c.default_forum_layout;
                if (c.default_thread_rate_limit_per_user != null) body.default_thread_rate_limit_per_user = c.default_thread_rate_limit_per_user;
            }
            return body;
        };

        const createChannel = async (c: BackupChannel) => {
            const label = c.type === 4 ? `Category ${c.name}` : `Channel #${c.name}`;
            step(label);
            const fallback = TYPE_FALLBACK[c.type];
            const hasMembers = c.permission_overwrites.some(o => o.type === 1);
            const variants: { type: number; members: boolean; note?: string; }[] = [{ type: c.type, members: true }];
            if (fallback != null) variants.push({ type: fallback, members: true, note: "as a regular channel (target server without Community)" });
            if (hasMembers) variants.push({ type: fallback ?? c.type, members: false, note: "without member permissions" });

            let lastError: unknown;
            for (const v of variants) {
                try {
                    const created = await api("post", { url: `/guilds/${target}/channels`, body: buildBody(c, v.type, v.members) }, opts);
                    if (created?.id) channelMap.set(c.id, created.id);
                    stats.ok++;
                    if (v.note) log("warn", `${label}: ${v.note}`);
                    return;
                } catch (e) {
                    if (isCancelled(e)) throw e;
                    lastError = e;
                    // Only try variants on validation errors (400)
                    if (!(e instanceof ApiError) || e.status !== 400) break;
                    total++;
                }
            }
            stats.failed++;
            log("error", `${label}: ${describeError(lastError)}`);
        };

        const categories = backup.channels.filter(c => c.type === 4);
        const others = backup.channels.filter(c => c.type !== 4);
        for (const c of categories) await createChannel(c);
        for (const c of others) await createChannel(c);
        log("ok", `${channelMap.size}/${backup.channels.length} categories & channels created`);
    }

    // ---- 4. Emojis
    if (plan.sections.emojis) {
        let count = 0;
        for (const e of backup.emojis) {
            if (!e.file || !files[e.file]) {
                log("warn", `Emoji :${e.name}: skipped (no image file)`);
                continue;
            }
            const image = await toDataUri(files[e.file], mimeOf(e.file));
            const roles = e.roles.map(id => roleMap.get(id)).filter(Boolean);
            const res = await attempt(`Emoji :${e.name}:`, () => api("post", { url: `/guilds/${target}/emojis`, body: { name: e.name, image, roles } }, opts));
            if (res) count++;
        }
        log("ok", `${count}/${backup.emojis.length} emojis uploaded`);
    }

    // ---- 5. Stickers
    if (plan.sections.stickers) {
        let count = 0;
        for (const s of backup.stickers) {
            if (s.format_type === 3) {
                log("info", `Sticker ${s.name}: Lottie stickers cannot be uploaded`);
                continue;
            }
            if (!s.file || !files[s.file]) {
                log("warn", `Sticker ${s.name} skipped (no image file)`);
                continue;
            }
            const form = new FormData();
            form.append("name", s.name);
            form.append("description", s.description);
            form.append("tags", s.tags || "⭐");
            form.append("file", new Blob([files[s.file] as BlobPart], { type: mimeOf(s.file) }), s.file.split("/").pop());
            const res = await attempt(`Sticker ${s.name}`, () => api("post", { url: `/guilds/${target}/stickers`, body: form }, opts));
            if (res) count++;
        }
        log("ok", `${count}/${backup.stickers.length} stickers uploaded`);
    }

    // ---- 6. Server settings
    if (plan.sections.settings) {
        const g = backup.guild;
        const mapCh = (id: string | null) => id ? channelMap.get(id) ?? undefined : undefined;
        const body: Record<string, any> = {
            name: g.name,
            verification_level: g.verification_level,
            default_message_notifications: g.default_message_notifications,
            explicit_content_filter: g.explicit_content_filter,
            afk_timeout: g.afk_timeout,
            system_channel_flags: g.system_channel_flags,
            preferred_locale: g.preferred_locale
        };
        const afk = mapCh(g.afk_channel_id);
        if (afk) body.afk_channel_id = afk;
        const sys = mapCh(g.system_channel_id);
        if (sys) body.system_channel_id = sys;
        if (g.icon && files[g.icon]) body.icon = await toDataUri(files[g.icon], mimeOf(g.icon));
        if (g.banner && files[g.banner] && targetGuild.features?.has?.("BANNER")) body.banner = await toDataUri(files[g.banner], mimeOf(g.banner));
        if (g.splash && files[g.splash] && targetGuild.features?.has?.("INVITE_SPLASH")) body.splash = await toDataUri(files[g.splash], mimeOf(g.splash));

        step("Server settings");
        try {
            await api("patch", { url: `/guilds/${target}`, body }, opts);
            stats.ok++;
            log("ok", "Server settings applied");
        } catch (e) {
            if (isCancelled(e)) throw e;
            // Try individually so one invalid field doesn't block everything
            log("warn", `Server settings: ${describeError(e)} - trying individually`);
            const keys = Object.keys(body);
            total += keys.length;
            for (const key of keys) {
                await attempt(`Setting ${key}`, () => api("patch", { url: `/guilds/${target}`, body: { [key]: body[key] } }, opts));
            }
        }
    }

    hooks.onProgress(total, total, "Done");
    return stats;
}
