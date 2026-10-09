/*
 * Radar – runs in the Electron main process
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { BrowserWindow, IpcMainInvokeEvent, shell } from "electron";
import { createWriteStream, promises as fs } from "fs";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

/** Windows already waiting for "focus" (otherwise listeners pile up) */
const waiting = new WeakSet<BrowserWindow>();

/**
 * Flash the taskbar icon until the window regains focus.
 * If Discord currently has focus, nothing happens.
 */
export function flashFrame(event: IpcMainInvokeEvent) {
    const own = BrowserWindow.fromWebContents(event.sender);
    const windows = own ? [own] : BrowserWindow.getAllWindows();
    let flashed = false;

    for (const win of windows) {
        if (!win || win.isDestroyed() || win.isFocused()) continue;
        win.flashFrame(true);
        flashed = true;

        if (!waiting.has(win)) {
            waiting.add(win);
            win.once("focus", () => {
                waiting.delete(win);
                if (!win.isDestroyed()) win.flashFrame(false);
            });
        }
    }
    return flashed;
}

/** Stop flashing immediately (e.g. when the plugin is disabled) */
export function stopFlash(event: IpcMainInvokeEvent) {
    const own = BrowserWindow.fromWebContents(event.sender);
    for (const win of own ? [own] : BrowserWindow.getAllWindows()) {
        if (win && !win.isDestroyed()) win.flashFrame(false);
    }
}

// ---------------------------------------------------------------- Bookmark media

/** Images, videos and avatars of bookmarks, one folder per bookmark */
const MEDIA_DIR = join(DATA_DIR, "RadarBookmarks");
/** Bigger files are skipped (protects the disk from accidental 500 MB videos) */
const MAX_FILE_BYTES = 250 * 1024 * 1024;

function bookmarkDir(bookmarkId: unknown) {
    if (typeof bookmarkId !== "string" || !/^[a-z0-9]{6,40}$/i.test(bookmarkId)) throw new Error("Invalid bookmark id");
    return join(MEDIA_DIR, bookmarkId);
}

function safeFileName(name: unknown) {
    if (typeof name !== "string" || !/^[\w.-]{1,120}$/.test(name) || name.startsWith(".")) throw new Error("Invalid file name");
    return name;
}

/** Only Discord's own servers: the renderer can't make the main process fetch arbitrary addresses */
function isDiscordUrl(url: string) {
    try {
        const u = new URL(url);
        return u.protocol === "https:" && /(^|\.)(discordapp\.com|discordapp\.net|discord\.com)$/.test(u.hostname);
    } catch {
        return false;
    }
}

export interface MediaDownload {
    url: string;
    /** Target file name inside the bookmark folder */
    file: string;
}

/** Saves the files of one bookmark. Returns the file names that were saved. */
export async function saveBookmarkMedia(_: IpcMainInvokeEvent, bookmarkId: string, items: MediaDownload[]) {
    const dir = bookmarkDir(bookmarkId);
    await fs.mkdir(dir, { recursive: true });
    const saved: string[] = [];

    for (const item of Array.isArray(items) ? items : []) {
        try {
            const file = safeFileName(item?.file);
            if (!isDiscordUrl(item.url)) continue;
            const res = await fetch(item.url);
            if (!res.ok || !res.body) continue;
            if (Number(res.headers.get("content-length")) > MAX_FILE_BYTES) continue;

            const target = join(dir, file);
            let bytes = 0;
            const body = Readable.fromWeb(res.body as any);
            body.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > MAX_FILE_BYTES) body.destroy(new Error("File too big"));
            });
            try {
                await pipeline(body, createWriteStream(target));
                saved.push(file);
            } catch {
                await fs.rm(target, { force: true });
            }
        } catch { }
    }
    return saved;
}

/** File contents for showing a saved picture or video */
export async function readBookmarkMedia(_: IpcMainInvokeEvent, bookmarkId: string, file: string) {
    return new Uint8Array(await fs.readFile(join(bookmarkDir(bookmarkId), safeFileName(file))));
}

export async function deleteBookmarkMedia(_: IpcMainInvokeEvent, bookmarkId: string) {
    await fs.rm(bookmarkDir(bookmarkId), { recursive: true, force: true });
}

/** Opens the folder of one bookmark, or the folder with all of them */
export async function openBookmarkFolder(_: IpcMainInvokeEvent, bookmarkId?: string) {
    const dir = bookmarkId ? bookmarkDir(bookmarkId) : MEDIA_DIR;
    await fs.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
}

/** Disk space used by all saved bookmark media, in bytes */
export async function bookmarkMediaSize() {
    let total = 0;
    const walk = async (dir: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) await walk(path);
            else total += (await fs.stat(path).catch(() => null))?.size ?? 0;
        }
    };
    await walk(MEDIA_DIR);
    return total;
}
