// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";

import { coverScript, mediaScript } from "./mediaScript";
import { decodeTrack, type Track } from "./presence";
import { safeCoverUrl, trackKey } from "./artwork";

interface Snapshot {
    status: "ready" | "idle" | "error" | "unsupported";
    track: Track | null;
}

let cached: Snapshot = { status: "idle", track: null };
let watcher: ChildProcess | undefined;
let watchdog: ReturnType<typeof setInterval> | undefined;
let lastRead = 0;
let lastSnapshot = 0;
let retryAt = 0;

export function stopTrack(_event: IpcMainInvokeEvent): void {
    const child = watcher;
    watcher = undefined;
    clearInterval(watchdog);
    watchdog = undefined;
    cached = { status: "idle", track: null };
    lastSnapshot = 0;
    retryAt = 0;
    child?.kill();
}

function startWatcher() {
    lastSnapshot = 0;
    const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(mediaScript, "utf16le").toString("base64")], {
        windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
    });
    watcher = child;
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
        if (watcher !== child) return;
        buffer += chunk;
        if (buffer.length > 65536) { child.kill(); return; }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).replace(/^\uFEFF/, "").trim();
            buffer = buffer.slice(newline + 1);
            let snapshot: Snapshot = { status: "error", track: null };
            try {
                const parsed = JSON.parse(line);
                const track = decodeTrack(parsed.track);
                if (parsed.status === "idle") snapshot = { status: "idle", track: null };
                else if (parsed.status === "ready" && track) snapshot = { status: "ready", track };
            } catch { /* Invalid snapshots clear the old song. */ }
            cached = snapshot;
            lastSnapshot = Date.now();
        }
    });
    const ended = () => {
        if (watcher !== child) return;
        watcher = undefined;
        clearInterval(watchdog);
        watchdog = undefined;
        cached = { status: "error", track: null };
        retryAt = Date.now() + 3000;
    };
    child.on("error", ended);
    child.on("exit", ended);
    const startedAt = Date.now();
    watchdog = setInterval(() => {
        if (Date.now() - lastRead > 15000) {
            watcher = undefined;
            clearInterval(watchdog);
            watchdog = undefined;
            cached = { status: "idle", track: null };
            lastSnapshot = 0;
            child.kill();
        } else if (Date.now() - (lastSnapshot || startedAt) > 10000) {
            cached = { status: "error", track: null };
            child.kill();
        }
    }, 1000);
    watchdog.unref();
}

// Media IPC accepts no paths, commands, URLs or account credentials.
export async function readTrack(_event: IpcMainInvokeEvent): Promise<Snapshot> {
    if (process.platform !== "win32") return { status: "unsupported", track: null };
    lastRead = Date.now();
    if (!watcher && lastRead >= retryAt) startWatcher();
    if (lastSnapshot && lastRead - lastSnapshot > 10000) return { status: "error", track: null };
    return cached;
}

const coverCache = new Map<string, { url: string | null; expires: number; }>();
const coverRequests = new Map<string, Promise<string | null>>();
let lastUpload = 0;

/** Reads the cover Spotify hands to Windows. Only returns it if it belongs to the asked song. */
function readSpotifyCover(title: string, artist: string): Promise<Buffer | null> {
    return new Promise(resolve => {
        const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(coverScript, "utf16le").toString("base64")], {
            windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
        });
        let out = "";
        const timer = setTimeout(() => child.kill(), 15000);
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
            out += chunk;
            if (out.length > 8_000_000) child.kill();
        });
        child.on("error", () => { clearTimeout(timer); resolve(null); });
        child.on("close", () => {
            clearTimeout(timer);
            try {
                const parsed = JSON.parse(out.replace(/^\uFEFF/, "").trim());
                if (typeof parsed.data !== "string" || parsed.title?.trim() !== title || parsed.artist?.trim() !== artist) return resolve(null);
                const image = Buffer.from(parsed.data, "base64");
                resolve(imageType(image) ? image : null);
            } catch { resolve(null); }
        });
    });
}

function imageType(image: Buffer): "jpg" | "png" | null {
    if (image.length < 100 || image.length > 5_000_000) return null;
    if (image[0] === 0xFF && image[1] === 0xD8 && image[2] === 0xFF) return "jpg";
    if (image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return "png";
    return null;
}

// Fixed host; only the picture is sent (no title, artist or account data). Litterbox deletes it after 24 hours.
async function uploadCover(image: Buffer): Promise<string | null> {
    const wait = lastUpload + 3000 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastUpload = Date.now();
    const type = imageType(image)!;
    const form = new FormData();
    form.set("reqtype", "fileupload");
    form.set("time", "24h");
    form.set("fileToUpload", new Blob([new Uint8Array(image)], { type: type === "jpg" ? "image/jpeg" : "image/png" }), `cover.${type}`);
    const response = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
        method: "POST", body: form, signal: AbortSignal.timeout(20000), redirect: "error"
    });
    return response.ok ? safeCoverUrl((await response.text()).trim()) : null;
}

// Called only after the cover opt-in. Takes the song only to check the picture, nothing of it is sent anywhere.
export async function findCover(_event: IpcMainInvokeEvent, title: unknown, artist: unknown, album: unknown): Promise<string | null> {
    if (process.platform !== "win32" || typeof title !== "string" || typeof artist !== "string" || typeof album !== "string"
        || !title.trim() || title.length > 128 || artist.length > 128 || album.length > 128) return null;
    const key = trackKey({ title, artist, album });
    const cachedCover = coverCache.get(key);
    if (cachedCover && cachedCover.expires > Date.now()) return cachedCover.url;
    if (coverRequests.has(key)) return coverRequests.get(key)!;
    const request = (async () => {
        let url: string | null = null;
        try {
            const image = await readSpotifyCover(title.trim(), artist.trim());
            if (image) url = await uploadCover(image);
        } catch { /* Cover failure must never interrupt music presence. */ }
        if (coverCache.size >= 200) coverCache.delete(coverCache.keys().next().value!);
        // Uploads live 24 h; reuse them for 20 h. Misses are retried soon, Spotify may set the cover a bit later.
        coverCache.set(key, { url, expires: Date.now() + (url ? 20 * 3600000 : 10000) });
        return url;
    })();
    coverRequests.set(key, request);
    try { return await request; }
    finally { coverRequests.delete(key); }
}
