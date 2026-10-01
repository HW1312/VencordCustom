/*
 * ServerDeclutter – Actions (mute, mark as read, archive folder, leave) with throttled processing
 * Nothing runs automatically: every action only starts after a click + confirmation.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { findByPropsLazy, proxyLazyWebpack } from "@webpack";
import { ActiveJoinedThreadsStore, FluxDispatcher, GuildChannelStore, GuildStore, ReadStateStore, RestAPI, SortedGuildStore, UserSettingsActionCreators, UserStore } from "@webpack/common";

const logger = new Logger("ServerDeclutter");

// Discord's own action for server notification settings (like NewGuildSettings)
const GuildNotificationActions = findByPropsLazy("updateGuildNotificationSettings");
const PreloadedUserSettings = proxyLazyWebpack(() => UserSettingsActionCreators.PreloadedUserSettingsActionCreators);

// ---------------------------------------------------------------- Cancelling

export class CancelledError extends Error {
    constructor() {
        super("Cancelled");
        this.name = "CancelledError";
    }
}

export const isCancelled = (e: unknown): e is CancelledError => e instanceof CancelledError;

export class CancelToken {
    cancelled = false;
    private listeners = new Set<() => void>();

    cancel() {
        if (this.cancelled) return;
        this.cancelled = true;
        this.listeners.forEach(fn => {
            try { fn(); } catch { /* ignore */ }
        });
        this.listeners.clear();
        activeTokens.delete(this);
    }

    onCancel(fn: () => void) {
        if (this.cancelled) fn();
        else this.listeners.add(fn);
        return () => void this.listeners.delete(fn);
    }
}

const activeTokens = new Set<CancelToken>();

export function createToken() {
    const t = new CancelToken();
    activeTokens.add(t);
    return t;
}

export function releaseToken(t: CancelToken) {
    activeTokens.delete(t);
}

export function cancelAll() {
    [...activeTokens].forEach(t => t.cancel());
}

export function sleep(ms: number, token?: CancelToken) {
    return new Promise<void>((resolve, reject) => {
        if (token?.cancelled) return reject(new CancelledError());
        let off = () => { };
        const timer = setTimeout(() => {
            off();
            resolve();
        }, Math.max(0, ms));
        if (token) off = token.onCancel(() => {
            clearTimeout(timer);
            reject(new CancelledError());
        });
    });
}

// ---------------------------------------------------------------- Errors

export function describeError(e: any): string {
    if (isCancelled(e)) return "Cancelled";
    const status = e?.status;
    const msg = e?.body?.message ?? e?.message ?? "Unknown error";
    switch (status) {
        case 401: return "Not signed in (401)";
        case 403: return `No permission (403) – ${msg}`;
        case 404: return "Not found (404)";
        case undefined:
        case null: return msg;
        default: return `Error ${status}: ${msg}`;
    }
}

// ---------------------------------------------------------------- Throttled processing

export interface BulkProgress {
    done: number;
    total: number;
    label: string;
}

export interface BulkResult {
    ok: string[];
    failed: { id: string; error: string; }[];
    cancelled: boolean;
}

export interface BulkOptions {
    token: CancelToken;
    /** Minimum interval between two servers (ms) */
    interval: number;
    onProgress(p: BulkProgress): void;
    onLog?(kind: "ok" | "warn" | "error", text: string): void;
}

const guildName = (id: string) => GuildStore.getGuild(id)?.name ?? id;

/**
 * Processes the servers one after another with a minimum interval. On 429, retry_after is awaited
 * and the same server is retried.
 */
export async function runBulk(ids: string[], worker: (id: string) => Promise<unknown>, opts: BulkOptions): Promise<BulkResult> {
    const result: BulkResult = { ok: [], failed: [], cancelled: false };
    const { token } = opts;

    try {
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (token.cancelled) throw new CancelledError();
            opts.onProgress({ done: i, total: ids.length, label: guildName(id) });

            for (let attempt = 0; ; attempt++) {
                try {
                    await worker(id);
                    result.ok.push(id);
                    opts.onLog?.("ok", guildName(id));
                    break;
                } catch (e: any) {
                    if (isCancelled(e)) throw e;
                    if (e?.status === 429 && attempt < 6) {
                        const seconds = Math.min(Number(e.body?.retry_after ?? 5) || 5, 600);
                        opts.onLog?.("warn", `Rate limited by Discord – waiting ${Math.ceil(seconds)} s`);
                        await sleep(seconds * 1000 + 300, token);
                        continue;
                    }
                    const error = describeError(e);
                    logger.error(`Action for ${id} failed`, e);
                    result.failed.push({ id, error });
                    opts.onLog?.("error", `${guildName(id)}: ${error}`);
                    break;
                }
            }

            opts.onProgress({ done: i + 1, total: ids.length, label: guildName(id) });
            if (i < ids.length - 1) await sleep(opts.interval, token);
        }
    } catch (e) {
        if (!isCancelled(e)) throw e;
        result.cancelled = true;
    }
    return result;
}

// ---------------------------------------------------------------- Single actions

export async function setGuildMuted(guildId: string, muted: boolean) {
    const update = GuildNotificationActions?.updateGuildNotificationSettings;
    if (typeof update === "function") {
        await update(guildId, muted
            ? { muted: true, mute_config: { selected_time_window: -1, end_time: null } }
            : { muted: false });
        return;
    }
    // Fallback: directly via the API
    await RestAPI.patch({
        url: `/users/@me/guilds/${guildId}/settings`,
        body: muted ? { muted: true, mute_config: { selected_time_window: -1, end_time: null } } : { muted: false },
        retries: 0
    } as any);
}

/** Like ReadAllNotificationsButton, but for a single server only */
export function markGuildRead(guildId: string) {
    const channels: { channelId: string; messageId: string | null; readStateType: number; }[] = [];
    const all = GuildChannelStore.getChannels(guildId);
    const threads = Object.values(ActiveJoinedThreadsStore.getActiveJoinedThreadsForGuild(guildId) ?? {})
        .flatMap((t: any) => Object.values(t));

    ([...(all?.SELECTABLE ?? []), ...(all?.VOCAL ?? []), ...threads] as any[]).forEach(c => {
        const id = c?.channel?.id;
        if (!id || !ReadStateStore.hasUnread(id)) return;
        channels.push({ channelId: id, messageId: ReadStateStore.lastMessageId(id), readStateType: 0 });
    });

    if (!channels.length) return 0;
    FluxDispatcher.dispatch({ type: "BULK_ACK", context: "APP", channels });
    return channels.length;
}

export function isOwnedGuild(guildId: string) {
    const me = UserStore.getCurrentUser()?.id;
    return !!me && GuildStore.getGuild(guildId)?.ownerId === me;
}

export async function leaveGuild(guildId: string) {
    // Safety net: never leave servers you own
    if (isOwnedGuild(guildId)) throw new Error("Owned server – will not be left");
    await RestAPI.del({ url: `/users/@me/guilds/${guildId}`, body: { lurking: false }, retries: 0 } as any);
}

// ---------------------------------------------------------------- Archive folder

/** Field type of a proto field (like searchProtoClassField in FakeNitro) */
function protoFieldType(protoClass: any, localName: string) {
    const field = protoClass?.fields?.find((f: any) => f.localName === localName);
    if (!field) return undefined;
    const getter = Object.values(field).find(v => typeof v === "function") as any;
    return getter?.();
}

function protoFieldInfo(protoClass: any, localName: string) {
    return protoClass?.fields?.find((f: any) => f.localName === localName);
}

/** 64-bit value in the format the proto expects (protobuf-ts LongType: 0 = bigint, 1 = string, 2 = number) */
function toLong(value: string | number, sample: unknown, info: any) {
    const kind = sample !== undefined ? typeof sample : info?.L === 1 ? "string" : info?.L === 2 ? "number" : "bigint";
    if (kind === "string") return String(value);
    if (kind === "number") return Number(value);
    return BigInt(value);
}

export function canWriteFolders() {
    try {
        return !!PreloadedUserSettings?.updateAsync && !!protoFieldType(PreloadedUserSettings.ProtoClass, "guildFolders");
    } catch {
        return false;
    }
}

/**
 * Moves servers into a folder (created if it does not exist).
 * Writes the server folder setting (guildFolders) with a single request.
 */
export async function moveToFolder(guildIds: string[], folderName: string) {
    const creators = PreloadedUserSettings;
    const FoldersClass = protoFieldType(creators?.ProtoClass, "guildFolders");
    const FolderClass = protoFieldType(FoldersClass, "folders");
    if (!creators?.updateAsync || !FolderClass) throw new Error("Server folders cannot be written in this Discord version");

    const IdClass = protoFieldType(FolderClass, "id");
    const NameClass = protoFieldType(FolderClass, "name");
    const move = new Set(guildIds.map(String));

    await creators.updateAsync("guildFolders", (draft: any) => {
        let folders: any[] = Array.isArray(draft.folders) ? draft.folders : [];

        // No folder data saved yet → adopt current order
        if (!folders.length) {
            folders = (SortedGuildStore.getGuildFolders() ?? []).map(f => FolderClass.create({
                guildIds: f.guildIds.map(id => toLong(id, undefined, protoFieldInfo(FolderClass, "guildIds"))),
                ...(f.folderId != null && IdClass ? { id: IdClass.create({ value: toLong(f.folderId, undefined, protoFieldInfo(IdClass, "value")) }) } : {}),
                ...(f.folderName && NameClass ? { name: NameClass.create({ value: f.folderName }) } : {})
            }));
        }

        const sampleGuildId = folders.find(f => f.guildIds?.length)?.guildIds[0];
        const sampleFolderId = folders.find(f => f.id?.value != null)?.id?.value;

        // Remove from all previous folders, discard empty folders
        for (const f of folders) f.guildIds = (f.guildIds ?? []).filter((id: any) => !move.has(String(id)));
        folders = folders.filter(f => f.guildIds.length > 0);

        let target = folders.find(f => f.id?.value != null && f.name?.value === folderName);
        if (!target) {
            if (!IdClass || !NameClass) throw new Error("Unknown folder format");
            const used = new Set(folders.map(f => String(f.id?.value)));
            let newId: number;
            do newId = Math.floor(Math.random() * 2 ** 31) + 1; while (used.has(String(newId)));
            target = FolderClass.create({
                guildIds: [],
                id: IdClass.create({ value: toLong(newId, sampleFolderId, protoFieldInfo(IdClass, "value")) }),
                name: NameClass.create({ value: folderName })
            });
            folders.push(target);
        }

        const info = protoFieldInfo(FolderClass, "guildIds");
        target.guildIds = [...target.guildIds, ...guildIds.map(id => toLong(id, sampleGuildId, info))];
        draft.folders = folders;
    }, 0);
}
