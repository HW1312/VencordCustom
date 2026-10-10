// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";

import { mediaScript } from "./mediaScript";
import { decodeTrack, type Track } from "./presence";
import { selectCover, trackKey } from "./artwork";

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

const coverCache = new Map<string, { url: string | null; expires: number }>();
const coverRequests = new Map<string, Promise<string | null>>();
let lastCoverRequest = 0;

// Called only after online-cover opt-in. Fixed API host; no OAuth or arbitrary URLs.
export async function findCover(_event: IpcMainInvokeEvent, title: unknown, artist: unknown, album: unknown, durationMs: unknown): Promise<string | null> {
    if (typeof title !== "string" || typeof artist !== "string" || typeof album !== "string"
        || !title.trim() || !artist.trim() || title.length > 128 || artist.length > 128 || album.length > 128
        || typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return null;
    const metadata = { title, artist, album, durationMs };
    const key = trackKey(metadata);
    const cachedCover = coverCache.get(key);
    if (cachedCover && cachedCover.expires > Date.now()) return cachedCover.url;
    if (coverRequests.has(key)) return coverRequests.get(key)!;
    if (Date.now() - lastCoverRequest < 3000) return null;
    lastCoverRequest = Date.now();
    const request = (async () => {
        let url: string | null = null;
        try {
            const endpoint = new URL("https://api.deezer.com/search");
            endpoint.searchParams.set("q", `${title} ${artist}`);
            endpoint.searchParams.set("limit", "25");
            const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000), redirect: "error" });
            if (response.ok) url = selectCover(metadata, await response.json());
        } catch { /* Cover failure must never interrupt music presence. */ }
        if (coverCache.size >= 200) coverCache.delete(coverCache.keys().next().value!);
        coverCache.set(key, { url, expires: Date.now() + (url ? 12 * 3600000 : 60000) });
        return url;
    })();
    coverRequests.set(key, request);
    try { return await request; }
    finally { coverRequests.delete(key); }
}
