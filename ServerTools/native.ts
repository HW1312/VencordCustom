/*
 * ServerTools – runs in the Electron main process
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

/** Only Discord's own CDN hosts - this helper is not a general-purpose proxy */
const ALLOWED_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/**
 * Downloads an image file (emoji, sticker, server icon ...) from the Discord CDN.
 * Only used as a fallback if the download in the renderer (CSP/CORS) fails.
 */
export async function fetchCdn(_: IpcMainInvokeEvent, url: string): Promise<{ status: number; data: Uint8Array | null; type: string; }> {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) return { status: -1, data: null, type: "" };

        const res = await fetch(parsed.href);
        if (!res.ok) return { status: res.status, data: null, type: "" };

        const data = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, data, type: res.headers.get("content-type") ?? "" };
    } catch {
        return { status: -1, data: null, type: "" };
    }
}
