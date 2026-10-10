/*
 * MediaGallery – Media index per channel (paging backwards through message history).
 * Forum and media channels have no messages of their own: there the pictures are in the posts (threads), so it
 * collects the first message of every post instead – open posts via /post-data (like Discord's forum view),
 * older ones via the forum's archive search, which already returns the first messages.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { findStoreLazy } from "@webpack";
import { ChannelStore, Constants, RestAPI } from "@webpack/common";

const ActiveThreadsStore = findStoreLazy("ActiveThreadsStore");

const logger = new Logger("MediaGallery");

// ---------------------------------------------------------------- Types

export type MediaKind = "image" | "video" | "gif" | "audio" | "file";

export interface MediaItem {
    /** Unique: message ID + source + index */
    key: string;
    messageId: string;
    channelId: string;
    guildId: string | null;
    kind: MediaKind;
    /** true = from a link embed instead of an attachment */
    embed: boolean;
    /** Original URL (for opening/downloading) */
    url: string;
    /** Media proxy URL (for thumbnails) */
    proxyUrl: string;
    /** Directly playable video URL (gifv/video embeds) */
    videoUrl?: string;
    filename: string;
    /** Bytes, 0 = unknown (embeds) */
    size: number;
    width?: number;
    height?: number;
    spoiler: boolean;
    authorId: string;
    timestamp: number;
}

export interface Author {
    id: string;
    name: string;
    avatarUrl: string;
    count: number;
}

export interface ChannelIndex {
    channelId: string;
    guildId: string | null;
    items: MediaItem[];
    keys: Set<string>;
    authors: Map<string, Author>;
    /** ID of the oldest loaded message (for before=) */
    oldestId: string | null;
    /** Forum / media channel: scans posts instead of messages */
    forum: boolean;
    /** Forum: open posts still to load, null = not listed yet */
    activeQueue: string[] | null;
    /** Forum: offset in the archive search */
    archiveOffset: number;
    /** Start of the channel reached */
    done: boolean;
    /** Number of scanned messages */
    scanned: number;
    loading: boolean;
    /** Currently waiting due to rate limit (seconds) */
    rateLimited: number;
    error: string | null;
    cancel: (() => void) | null;
    version: number;
    listeners: Set<() => void>;
}

// ---------------------------------------------------------------- Cache (this session only)

const cache = new Map<string, ChannelIndex>();

/** Forum (15) and media (16) channels */
export const isForum = (channelId: string) => {
    const type = ChannelStore.getChannel(channelId)?.type;
    return type === 15 || type === 16;
};

export function getIndex(channelId: string, guildId: string | null): ChannelIndex {
    let idx = cache.get(channelId);
    if (!idx) {
        idx = {
            channelId,
            guildId,
            items: [],
            keys: new Set(),
            authors: new Map(),
            oldestId: null,
            forum: isForum(channelId),
            activeQueue: null,
            archiveOffset: 0,
            done: false,
            scanned: 0,
            loading: false,
            rateLimited: 0,
            error: null,
            cancel: null,
            version: 0,
            listeners: new Set()
        };
        cache.set(channelId, idx);
    }
    return idx;
}

export function resetIndex(channelId: string) {
    const idx = cache.get(channelId);
    idx?.cancel?.();
    cache.delete(channelId);
}

/** On stop: cancel all running loads and clear the cache */
export function clearAll() {
    for (const idx of cache.values()) idx.cancel?.();
    cache.clear();
}

export function subscribe(idx: ChannelIndex, fn: () => void) {
    idx.listeners.add(fn);
    return () => void idx.listeners.delete(fn);
}

function emit(idx: ChannelIndex) {
    idx.version++;
    for (const fn of idx.listeners) {
        try { fn(); } catch (e) { logger.error(e); }
    }
}

// ---------------------------------------------------------------- Detection

const EXT = {
    image: /\.(png|jpe?g|webp|avif|bmp|heic|heif|tiff?)$/i,
    gif: /\.gif$/i,
    video: /\.(mp4|webm|mov|mkv|m4v|avi)$/i,
    audio: /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac)$/i
};

function kindOf(filename: string, contentType?: string): MediaKind {
    const ct = contentType?.toLowerCase() ?? "";
    if (ct === "image/gif" || EXT.gif.test(filename)) return "gif";
    if (ct.startsWith("image/") || EXT.image.test(filename)) return "image";
    if (ct.startsWith("video/") || EXT.video.test(filename)) return "video";
    if (ct.startsWith("audio/") || EXT.audio.test(filename)) return "audio";
    return "file";
}

function filenameFromUrl(url: string, fallback: string) {
    try {
        const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
        return name || fallback;
    } catch {
        return fallback;
    }
}

function authorName(a: any): string {
    return a?.global_name || a?.username || "Unknown";
}

function avatarUrl(a: any): string {
    if (a?.avatar) return `https://cdn.discordapp.com/avatars/${a.id}/${a.avatar}.webp?size=64`;
    let n = 0;
    try { n = Number((BigInt(a?.id ?? "0") >> 22n) % 6n); } catch { }
    return `https://cdn.discordapp.com/embed/avatars/${n}.png`;
}

/** Collects attachments and image/video embeds of a (raw) API message */
function extract(idx: ChannelIndex, msg: any) {
    const base = {
        messageId: msg.id as string,
        channelId: (msg.channel_id as string) ?? idx.channelId,
        guildId: idx.guildId,
        authorId: msg.author?.id as string ?? "0",
        timestamp: Date.parse(msg.timestamp) || 0
    };
    const found: MediaItem[] = [];

    (msg.attachments ?? []).forEach((a: any, i: number) => {
        const filename: string = a.filename || filenameFromUrl(a.url, "file");
        found.push({
            ...base,
            key: `${msg.id}:a${i}`,
            kind: kindOf(filename, a.content_type),
            embed: false,
            url: a.url,
            proxyUrl: a.proxy_url || a.url,
            filename,
            size: a.size ?? 0,
            width: a.width ?? undefined,
            height: a.height ?? undefined,
            spoiler: filename.startsWith("SPOILER_") || !!(a.flags & 8)
        });
    });

    (msg.embeds ?? []).forEach((e: any, i: number) => {
        const key = `${msg.id}:e${i}`;
        if (e.type === "gifv" && e.video) {
            found.push({
                ...base,
                key,
                kind: "gif",
                embed: true,
                url: e.url || e.video.url,
                proxyUrl: e.thumbnail?.proxy_url || e.thumbnail?.url || e.video.proxy_url,
                videoUrl: e.video.proxy_url || e.video.url,
                filename: filenameFromUrl(e.video.url || e.video.proxy_url, "gif.mp4"),
                size: 0,
                width: e.video.width,
                height: e.video.height,
                spoiler: false
            });
        } else if (e.type === "video" && e.video?.proxy_url) {
            // Only directly playable videos (no YouTube player)
            found.push({
                ...base,
                key,
                kind: "video",
                embed: true,
                url: e.video.url,
                proxyUrl: e.thumbnail?.proxy_url || e.video.proxy_url,
                videoUrl: e.video.proxy_url,
                filename: filenameFromUrl(e.video.url, "video.mp4"),
                size: 0,
                width: e.video.width,
                height: e.video.height,
                spoiler: false
            });
        } else {
            const img = e.type === "image" ? (e.thumbnail ?? e.image) : e.image;
            if (!img?.url) return;
            const filename = filenameFromUrl(img.url, "image");
            found.push({
                ...base,
                key,
                kind: EXT.gif.test(filename) ? "gif" : "image",
                embed: true,
                url: img.url,
                proxyUrl: img.proxy_url || img.url,
                filename,
                size: 0,
                width: img.width,
                height: img.height,
                spoiler: false
            });
        }
    });

    if (!found.length) return;

    let author = idx.authors.get(base.authorId);
    if (!author) {
        author = { id: base.authorId, name: authorName(msg.author), avatarUrl: avatarUrl(msg.author), count: 0 };
        idx.authors.set(author.id, author);
    }

    for (const item of found) {
        if (idx.keys.has(item.key)) continue;
        idx.keys.add(item.key);
        idx.items.push(item);
        author.count++;
    }
}

// ---------------------------------------------------------------- Loading

/** Pause between two API requests (Discord ToS: not too fast) */
const REQUEST_DELAY = 1100;

function sleep(ms: number, signal: { cancelled: boolean; wake?: () => void; }) {
    return new Promise<void>(resolve => {
        if (signal.cancelled) return resolve();
        const t = setTimeout(resolve, ms);
        signal.wake = () => { clearTimeout(t); resolve(); };
    });
}

/** Open posts per /post-data request (Discord's forum view asks for 10 at a time) */
const POSTS_PER_REQUEST = 10;
/** Archived posts per search request */
const ARCHIVE_PAGE = 25;

/** All values of a list or an id → value map */
const valuesOf = (x: any): any[] => Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : [];

/** One request of a forum: first a batch of open posts, then pages of the archive. Throws like RestAPI (429 etc.). */
async function loadForumBatch(idx: ChannelIndex) {
    if (idx.activeQueue === null) {
        const threads = idx.guildId ? ActiveThreadsStore.getThreadsForParent(idx.guildId, idx.channelId) : null;
        idx.activeQueue = Object.keys(threads ?? {});
    }

    if (idx.activeQueue.length) {
        const ids = idx.activeQueue.slice(0, POSTS_PER_REQUEST);
        const res = await RestAPI.post({
            url: `/channels/${idx.channelId}/post-data`,
            body: { thread_ids: ids },
            retries: 1
        });
        idx.activeQueue = idx.activeQueue.slice(ids.length);
        for (const post of valuesOf(res?.body?.threads)) {
            const msg = post?.first_message ?? post?.firstMessage;
            if (msg) extract(idx, { channel_id: msg.channel_id ?? post.id, ...msg });
        }
        idx.scanned += ids.length;
        return;
    }

    const res = await RestAPI.get({
        url: `/channels/${idx.channelId}/threads/search`,
        query: { archived: true, sort_by: "last_message_time", sort_order: "desc", limit: ARCHIVE_PAGE, offset: idx.archiveOffset },
        retries: 1
    });
    const body = res?.body ?? {};
    const threads = valuesOf(body.threads);
    for (const msg of valuesOf(body.first_messages)) extract(idx, msg);
    idx.archiveOffset += threads.length;
    idx.scanned += threads.length;
    if (!body.has_more || !threads.length) idx.done = true;
}

/**
 * Loads up to `pages` pages (of 100 messages) backwards. Infinity = up to the start of the channel.
 * If a load is already running, nothing happens.
 */
export async function loadPages(idx: ChannelIndex, pages: number) {
    if (idx.loading || idx.done) return;

    const signal: { cancelled: boolean; wake?: () => void; } = { cancelled: false };
    idx.loading = true;
    idx.error = null;
    idx.cancel = () => {
        signal.cancelled = true;
        signal.wake?.();
    };
    emit(idx);

    let loaded = 0;
    try {
        while (loaded < pages && !idx.done && !signal.cancelled) {
            if (loaded > 0) await sleep(REQUEST_DELAY, signal);
            if (signal.cancelled) break;

            let res: any;
            try {
                if (idx.forum) {
                    await loadForumBatch(idx);
                    loaded++;
                    emit(idx);
                    continue;
                }
                res = await RestAPI.get({
                    url: Constants.Endpoints.MESSAGES(idx.channelId),
                    query: { limit: 100, ...(idx.oldestId ? { before: idx.oldestId } : {}) },
                    retries: 1
                });
            } catch (e: any) {
                if (e?.status === 429) {
                    const wait = Math.ceil((e.body?.retry_after ?? 5) * 1000) + 250;
                    idx.rateLimited = Math.ceil(wait / 1000);
                    emit(idx);
                    await sleep(wait, signal);
                    idx.rateLimited = 0;
                    continue;
                }
                throw e;
            }

            const messages: any[] = Array.isArray(res?.body) ? res.body : [];
            for (const msg of messages) extract(idx, msg);

            idx.scanned += messages.length;
            if (messages.length) idx.oldestId = messages[messages.length - 1].id;
            if (messages.length < 100) idx.done = true;

            loaded++;
            emit(idx);
        }
    } catch (e: any) {
        logger.error("Messages could not be loaded", e);
        idx.error = e?.status === 403
            ? "No permission to read the history of this channel."
            : e?.body?.message || e?.message || "Unknown error while loading.";
    } finally {
        idx.loading = false;
        idx.rateLimited = 0;
        idx.cancel = null;
        emit(idx);
    }
}
