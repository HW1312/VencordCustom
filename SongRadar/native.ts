/*
 * SongRadar – runs in the Electron main process.
 * - recognize(): sends a fingerprint (made in signature.ts) to Shazam, the same request the Shazam Android app and
 *   SongRec make. No account or key. Only the fingerprint leaves the PC, never the audio.
 * - screenSourceId(): a screen id for Chromium's desktop capture, which also delivers the system sound (Windows).
 * - downloadMedia(): bytes of a video / audio attachment from Discord's CDN (the page can't read them: CORS).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CspPolicies, ImageAndMediaSrc, ImageSrc } from "@main/csp";
import { desktopCapturer, IpcMainInvokeEvent } from "electron";

// Discord's content security policy blocks images and audio from unknown servers: allow Apple's covers
// (is1-ssl.mzstatic.com …), the 30 s previews and Shazam's images. Applies from the next Discord start.
CspPolicies["*.mzstatic.com"] = ImageAndMediaSrc;
CspPolicies["audio-ssl.itunes.apple.com"] = ImageAndMediaSrc;
CspPolicies["images.shazam.com"] = ImageSrc;

const SIG_PREFIX = "data:audio/vnd.shazam.sig;base64,";
const USER_AGENT = "Dalvik/2.1.0 (Linux; U; Android 6.0.1; SM-G920F Build/MMB29K)";

export async function recognize(_: IpcMainInvokeEvent, uri: string, sampleMs: number) {
    if (typeof uri !== "string" || !uri.startsWith(SIG_PREFIX) || uri.length > 400_000) throw new Error("Invalid fingerprint");
    const ms = Math.max(0, Math.min(60_000, Math.round(Number(sampleMs) || 0)));

    const timestamp = Date.now();
    const body = {
        geolocation: { altitude: 300, latitude: 45, longitude: 2 },
        signature: { samplems: ms, timestamp, uri },
        timestamp,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin"
    };
    const url = `https://amp.shazam.com/discovery/v5/en/US/android/-/tag/${crypto.randomUUID().toUpperCase()}/${crypto.randomUUID()}`
        + "?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v3";

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Language": "en_US", "User-Agent": USER_AGENT },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000)
    });
    if (res.status === 429) throw new Error("Too many searches from your internet connection – try again in a few minutes.");
    if (!res.ok) throw new Error(`Shazam: HTTP ${res.status}`);
    return await res.json();
}

export async function screenSourceId(_: IpcMainInvokeEvent) {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    return sources[0]?.id ?? null;
}

const MEDIA_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const MAX_MEDIA = 80 * 1024 * 1024;

export async function downloadMedia(_: IpcMainInvokeEvent, url: string) {
    const u = new URL(url);
    if (u.protocol !== "https:" || !MEDIA_HOSTS.has(u.hostname)) throw new Error("Only Discord attachments can be recognized");
    const res = await fetch(u, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const size = Number(res.headers.get("content-length") || 0);
    if (size > MAX_MEDIA) throw new Error("This file is too big to recognize");
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length > MAX_MEDIA) throw new Error("This file is too big to recognize");
    return data;
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** First YouTube result for a song (for "Download MP3", which hands the link to MediaGrab / yt-dlp) */
export async function findYouTube(_: IpcMainInvokeEvent, title: string, artist: string) {
    const q = encodeURIComponent(`${String(title)} ${String(artist)} audio`.slice(0, 200));
    const res = await fetch(`https://www.youtube.com/results?search_query=${q}`, {
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.8" },
        signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) throw new Error(`YouTube: HTTP ${res.status}`);
    const id = /"videoId":"([\w-]{11})"/.exec(await res.text())?.[1];
    return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

const IMAGE_HOSTS = /(^|\.)(mzstatic\.com|shazam\.com)$/;

/** Cover as a data: URL – fallback if Discord's content security policy still blocks the image */
export async function fetchImage(_: IpcMainInvokeEvent, url: string) {
    const u = new URL(url);
    if (u.protocol !== "https:" || !IMAGE_HOSTS.test(u.hostname)) throw new Error("Unknown image host");
    const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > 3 * 1024 * 1024) throw new Error("Image too big");
    return `data:${res.headers.get("content-type") || "image/jpeg"};base64,${data.toString("base64")}`;
}
