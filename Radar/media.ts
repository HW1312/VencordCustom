/*
 * Radar – images, videos and files of bookmarks: collect them from a message, save them on this PC
 * (so they survive when Discord deletes the message) and show them again from there.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { IconUtils, MessageStore, useEffect, UserStore, useState } from "@webpack/common";

import { Bookmark, bookmarksStore, logger, SavedMedia } from "./store";

const Native = VencordNative.pluginHelpers.Radar as PluginNative<typeof import("./native")>;

/** At most this many files per bookmark */
const MAX_MEDIA = 12;

function kindOf(contentType: string | undefined, name: string): SavedMedia["kind"] {
    const type = contentType ?? "";
    if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif)$/i.test(name)) return "image";
    if (type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(name)) return "video";
    return "file";
}

const isDiscordUrl = (url: string | undefined): url is string => !!url && /^https:\/\/([\w-]+\.)*(discordapp\.com|discordapp\.net|discord\.com)\//.test(url);

/** Attachments and pictures/videos from links (also of forwarded messages) */
export function collectMedia(message: any): SavedMedia[] {
    const sources = [message, ...(message.messageSnapshots ?? []).map((s: any) => s?.message)].filter(Boolean);
    const media: SavedMedia[] = [];

    for (const src of sources) {
        for (const a of src.attachments ?? []) {
            if (!a?.url) continue;
            media.push({
                key: String(a.id),
                kind: kindOf(a.content_type, a.filename ?? ""),
                name: a.filename ?? "file",
                url: a.url,
                width: a.width ?? undefined,
                height: a.height ?? undefined,
                size: a.size ?? undefined
            });
        }
        (src.embeds ?? []).forEach((e: any, i: number) => {
            // Discord's proxy copy, the original link could be anywhere
            const video = isDiscordUrl(e?.video?.proxyURL) ? e.video : null;
            const image = video ? null : [e?.image, e?.thumbnail].find(x => isDiscordUrl(x?.proxyURL));
            const item = video ?? image;
            if (!item) return;
            media.push({
                key: `embed-${media.length}-${i}`,
                kind: video ? "video" : "image",
                name: decodeURIComponent(new URL(item.proxyURL).pathname.split("/").pop() || "embed"),
                url: item.proxyURL,
                width: item.width ?? undefined,
                height: item.height ?? undefined
            });
        });
    }
    return media.slice(0, MAX_MEDIA);
}

function extensionOf(m: SavedMedia) {
    const ext = /\.([a-z0-9]{1,6})$/i.exec(m.name)?.[1];
    return ext ? `.${ext.toLowerCase()}` : m.kind === "image" ? ".png" : m.kind === "video" ? ".mp4" : "";
}

/** File name on disk: attachment id + extension, never the (untrusted) original name */
const localName = (m: SavedMedia) => `${m.key.replace(/[^\w-]/g, "")}${extensionOf(m)}`;

function bigAvatarUrl(userId: string, fallback?: string) {
    try {
        const user = UserStore.getUser(userId);
        if (user) return IconUtils.getUserAvatarURL(user, false, 256);
    } catch { }
    return fallback;
}

function patch(id: string, changes: Partial<Bookmark>) {
    bookmarksStore.update(list => list.map(b => b.id === id ? { ...b, ...changes } : b));
}

/**
 * Discord's file links expire after about a day. If the message is still in Discord's cache, take
 * fresh links from there (also fills in media for bookmarks made before Radar saved media).
 */
function withFreshLinks(bookmark: Bookmark): SavedMedia[] {
    const old = bookmark.media ?? [];
    const message = MessageStore.getMessage(bookmark.message.channelId, bookmark.message.messageId);
    if (!message) return old;
    return collectMedia(message).map(m => {
        const known = old.find(o => o.key === m.key);
        return known?.local ? known : m;
    });
}

/** Downloads everything not saved yet. Runs in the background, the bookmark updates when done. */
export async function saveMediaOffline(bookmark: Bookmark) {
    const media = withFreshLinks(bookmark);
    patch(bookmark.id, { media });
    const items = media.filter(m => !m.local).map(m => ({ url: m.url, file: localName(m) }));
    const avatarUrl = !bookmark.avatarLocal && bookmark.message.authorId ? bigAvatarUrl(bookmark.message.authorId, bookmark.message.authorAvatar) : undefined;
    const avatarFile = avatarUrl ? "avatar.png" : undefined;
    if (avatarUrl && avatarFile) items.push({ url: avatarUrl, file: avatarFile });

    patch(bookmark.id, { offline: true, saveState: items.length ? "saving" : undefined });
    if (!items.length) return;

    let saved: string[] = [];
    try {
        saved = await Native.saveBookmarkMedia(bookmark.id, items);
    } catch (e) {
        logger.error("Could not save bookmark media", e);
    }

    // The bookmark may have been deleted or switched back to online-only meanwhile
    const current = bookmarksStore.value.find(b => b.id === bookmark.id);
    if (!current?.offline) {
        Native.deleteBookmarkMedia(bookmark.id).catch(() => { });
        return;
    }
    const got = new Set(saved);
    const newMedia = (current.media ?? []).map(m => !m.local && got.has(localName(m)) ? { ...m, local: localName(m) } : m);
    const avatarLocal = current.avatarLocal ?? (avatarFile && got.has(avatarFile) ? avatarFile : undefined);
    const missing = newMedia.some(m => !m.local);
    patch(bookmark.id, { media: newMedia, avatarLocal, saveState: missing ? "failed" : undefined });
}

/** Back to Discord's links only: removes the files from this PC */
export function removeOfflineMedia(bookmark: Bookmark) {
    patch(bookmark.id, {
        offline: false,
        saveState: undefined,
        avatarLocal: undefined,
        media: bookmark.media?.map(({ local, ...m }) => m)
    });
    Native.deleteBookmarkMedia(bookmark.id).catch(e => logger.error("Could not delete bookmark media", e));
}

export function deleteMediaFiles(bookmarkId: string) {
    Native.deleteBookmarkMedia(bookmarkId).catch(e => logger.error("Could not delete bookmark media", e));
}

export const openBookmarkFolder = (bookmarkId?: string) => Native.openBookmarkFolder(bookmarkId).catch(e => logger.error("Could not open folder", e));
export const bookmarkMediaSize = () => Native.bookmarkMediaSize();

const MIME: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4"
};

/** Saved files already loaded: "bookmarkId/file" → object URL (kept small, videos are big) */
const urlCache = new Map<string, string>();
const CACHE_LIMIT = 40;

async function loadLocal(bookmarkId: string, file: string) {
    const cacheKey = `${bookmarkId}/${file}`;
    const cached = urlCache.get(cacheKey);
    if (cached) return cached;
    const data = await Native.readBookmarkMedia(bookmarkId, file);
    const type = MIME[file.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
    const url = URL.createObjectURL(new Blob([data], { type }));
    urlCache.set(cacheKey, url);
    if (urlCache.size > CACHE_LIMIT) {
        const [oldKey, oldUrl] = urlCache.entries().next().value!;
        urlCache.delete(oldKey);
        URL.revokeObjectURL(oldUrl);
    }
    return url;
}

/**
 * Address to show a file from: the copy on this PC if there is one, otherwise Discord's link.
 * Returns undefined while the local copy loads.
 */
export function useMediaSrc(bookmarkId: string, local: string | undefined, remote: string | undefined, enabled = true) {
    const [src, setSrc] = useState<string | undefined>(() => local ? urlCache.get(`${bookmarkId}/${local}`) : remote);
    useEffect(() => {
        if (!enabled) return;
        if (!local) {
            setSrc(remote);
            return;
        }
        let alive = true;
        loadLocal(bookmarkId, local)
            .then(url => alive && setSrc(url))
            .catch(() => alive && setSrc(remote));
        return () => { alive = false; };
    }, [bookmarkId, local, remote, enabled]);
    return src;
}

export function formatBytes(bytes: number) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
